/* 字幕工房 — 編輯器邏輯（原生 JS，無框架）
 * 後端：window.pywebview.api；用 http 伺服器或瀏覽器直接開啟時退回 mock（方便開發測試）。
 * 側欄切換、逐字稿轉檔、模型頁、關於頁在 shell.js（載入順序在本檔之後，共用這裡的 api / $ / toast / video）。
 *
 * 架構：
 *   state.cues 是唯一的資料來源；所有修改都走 commit(標籤, fn)，fn 改完後自動排序、夾限、
 *   記錄到 history（可復原／重做）、重畫列表、排程存檔。
 *   每幀只做便宜的事：找目前句用二分搜尋，波形的峰值與字幕框各畫在離屏 canvas 快取，
 *   只有資料變了才重畫；播放頭另外畫。 */
'use strict';

// ========== API（pywebview 或 mock） ==========
let api = null;

const mockApi = (() => {
  let cues = [], scenes = [4, 8, 12, 16], gloss = ['壹加壹'], styles = [], job = null;
  let projects = [{ name: 'demo', media: 'test_video.mp4', updated: Date.now() / 1000 }];
  return {
    async _init() {
      try {
        const r = await fetch('../projects/demo/project.json');
        const d = await r.json();
        cues = d.cues || []; scenes = d.scenes?.length ? d.scenes : scenes;
      } catch (e) { /* 無 demo 專案時給空白 */ }
    },
    list_projects: async () => projects.map(p => ({ ...p, cue_count: p.name === 'demo' ? cues.length : 0 })),
    open_project: async name => ({ name, media: 'test_video.mp4', media_url: '../test_video.mp4', cues: name === 'demo' ? cues : [], style: {}, scenes }),
    create_project: async (name, media) => { projects.unshift({ name, media, updated: Date.now() / 1000 }); return { ok: true }; },
    save_project: async (n, c) => { if (n === 'demo') cues = c; return { ok: true }; },
    delete_project: async name => { projects = projects.filter(p => p.name !== name); return { ok: true }; },
    pick_media: async () => (toast('mock 模式無法選檔'), null),
    pick_font: async () => (toast('mock 模式無法選字型'), null),
    start_transcribe: async () => {
      job = { state: 'running', progress: 0, status: '載入模型中…', t0: Date.now() };
      return { ok: true };
    },
    cancel_transcribe: async () => { if (job) job.state = 'cancelled'; return { ok: true }; },
    get_job: async () => {
      if (!job) return { state: 'idle', progress: 0 };
      if (job.state === 'running') {
        const el = (Date.now() - job.t0) / 1000;
        job.progress = Math.min(1, Math.max(0, (el - 1) / 3));
        job.status = job.progress > 0 ? `辨識中 ${Math.round(job.progress * 100)}%` : '載入模型中…';
        if (job.progress >= 1) job.state = 'done';
      }
      return job;
    },
    get_waveform: async () => { try { return await (await fetch('../projects/demo/waveform.json')).json(); } catch (e) { return { duration: 16, rate: 50, peaks: [] }; } },
    detect_scenes: async () => scenes,
    glossary_list: async () => gloss,
    glossary_add: async w => (gloss.includes(w) ? { added: false } : (gloss.push(w), { added: true })),
    glossary_remove: async w => { gloss = gloss.filter(x => x !== w); return { ok: true }; },
    learn_from_edit: async (o, n) => {
      if (o === n) return [];
      let i = 0; while (i < o.length && i < n.length && o[i] === n[i]) i++;
      let j = 0; while (j < o.length - i && j < n.length - i && o[o.length - 1 - j] === n[n.length - 1 - j]) j++;
      const a = Math.max(0, i - 2), b = Math.min(n.length, n.length - j + 2);
      const frag = n.slice(a, b).replace(/[，。、！？；：,.!?;:\s]/g, '');
      return frag.length >= 2 && frag.length <= 8 ? [frag] : [];
    },
    styles_list: async () => styles,
    styles_save: async (name, style) => { styles = styles.filter(s => s.name !== name); styles.unshift({ name, style }); return { ok: true }; },
    styles_delete: async name => { styles = styles.filter(s => s.name !== name); return { ok: true }; },
    has_ffmpeg: async () => false,
    export_subtitle: async (n, fmt) => ({ ok: true, path: `(mock) demo.${fmt}` }),
    burn_video: async () => ({ ok: false, msg: 'mock 模式不支援燒錄' }),
  };
})();

async function initApi() {
  // pywebview 注入 API 後會發 pywebviewready；桌面程式冷啟動可能要幾秒，耐心等，
  // 用 http 伺服器或瀏覽器直開時沒有 pywebview，很快退回 mock。
  const hasApi = () => !!(window.pywebview && window.pywebview.api);
  if (!hasApi()) {
    const limit = location.protocol === 'file:' ? 20000 : 1500;
    await Promise.race([
      new Promise(r => window.addEventListener('pywebviewready', r, { once: true })),
      new Promise(r => setTimeout(r, limit)),
    ]);
  }
  if (hasApi()) { api = window.pywebview.api; return; }
  api = mockApi;
  await mockApi._init();
}

// ========== 全域狀態 ==========
const $ = id => document.getElementById(id);
const state = {
  name: null, cues: [], scenes: [], marks: [],
  style: { font: 'Microsoft JhengHei', size: 64, color: '#ffffff', outline: 3, outline_color: '#000000', karaoke: false, karaoke_color: '#39ff14', pos_x: 0.5, pos_y: 0.82 },
  waveform: null, duration: 0, activeCue: -1, selected: -1, editing: -1, search: '', onlyIssues: false,
  follow: true, loopCue: false, scrub: false, userScrolledAt: 0,
  view: { t0: 0, span: 0 },        // 時間軸目前顯示的範圍（秒）；span=0 代表整段
  multi: new Set(),                // 多選的字幕 id
};
let nextCueId = 1;
const video = $('video');
const MIN_DUR = 0.05;
const round3 = x => Math.round(x * 1000) / 1000;
const isCjk = t => { const s = t.replace(/\s/g, ''); let n = 0; for (const ch of s) if (/[一-鿿぀-ヿ가-힯]/.test(ch)) n++; return n > s.length * 0.3; };
const confirmBox = opts => (window.__asConfirm ? window.__asConfirm(opts) : Promise.resolve(confirm(opts.text)));

function toast(msg, actions = [], key = null) {
  if (key) { const prev = document.querySelector(`.toast[data-key="${key}"]`); if (prev) prev.remove(); }
  const el = document.createElement('div');
  el.className = 'toast';
  if (key) el.dataset.key = key;
  el.append(Object.assign(document.createElement('span'), { textContent: msg }));
  for (const a of actions) {
    const b = Object.assign(document.createElement('button'), { className: 'btn', textContent: a.label });
    b.onclick = () => { a.fn(); el.remove(); };
    el.append(b);
  }
  $('toasts').append(el);
  setTimeout(() => el.remove(), actions.length ? 8000 : 3500);
}

// 時間格式：h:mm:ss.mmm（不足一小時不顯示小時）
function fmtT(s, ms = 1) {
  s = Math.max(0, +s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const secStr = ms === 3 ? sec.toFixed(3).padStart(6, '0') : sec.toFixed(1).padStart(4, '0');
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + secStr;
}
// 解析 1:02:03.5 / 62.5 / 1:02 → 秒；不合法回 NaN
function parseT(str) {
  const s = String(str).trim().replace('，', '.');
  if (!s) return NaN;
  const parts = s.split(':').map(Number);
  if (parts.some(x => Number.isNaN(x))) return NaN;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

// ========== 字幕資料：正規化、品質檢查、歷史 ==========
function normalizeCues(cues) {
  const out = [];
  for (const c of cues) {
    let start = +c.start, end = +c.end;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0) start = 0;
    if (end < start + MIN_DUR) end = start + MIN_DUR;
    out.push({ id: c.id || nextCueId++, start: round3(start), end: round3(end), text: String(c.text ?? ''), words: Array.isArray(c.words) ? c.words : [] });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

// 每句的時長、語速與問題（太短、太長、太快、重疊、沒文字）
function cueInfo(i) {
  const c = state.cues[i], next = state.cues[i + 1];
  const dur = c.end - c.start;
  const plain = c.text.replace(/\s/g, '');
  const cjk = isCjk(c.text);
  const units = cjk ? [...plain].length : c.text.trim().length;
  const cps = dur > 0 ? units / dur : 0;
  const issues = [];
  if (!c.text.trim()) issues.push('沒有文字');
  if (dur < 0.5) issues.push(`太短（${dur.toFixed(2)} 秒）`);
  else if (dur > 7) issues.push(`太長（${dur.toFixed(1)} 秒）`);
  if (cps > (cjk ? 8 : 20)) issues.push(`語速太快（每秒 ${cps.toFixed(1)} ${cjk ? '字' : '字元'}）`);
  if (next) {
    const gap = next.start - c.end;
    if (gap < -0.001) issues.push(`與下一句重疊 ${(-gap).toFixed(2)} 秒`);
    else if (gap > 0 && gap < 0.08) issues.push('與下一句間隔不足');
  }
  return { dur, cps, cjk, issues };
}
function issueCount() { let n = 0; for (let i = 0; i < state.cues.length; i++) if (cueInfo(i).issues.length) n++; return n; }

const history = { past: [], future: [], max: 100 };
const snapshot = () => JSON.stringify({ cues: state.cues, marks: state.marks });
function restoreSnap(snap) { const d = JSON.parse(snap); state.cues = d.cues; state.marks = d.marks || []; }

// 所有對字幕的修改都走這裡：記歷史、正規化、重畫、存檔。fn 回傳 false 表示放棄。
function commit(label, fn) {
  const before = snapshot();
  if (fn() === false) { restoreSnap(before); return false; }
  state.cues = normalizeCues(state.cues);
  history.past.push({ label, snap: before });
  if (history.past.length > history.max) history.past.shift();
  history.future.length = 0;
  afterChange();
  return true;
}
function undo() {
  const h = history.past.pop();
  if (!h) { toast('沒有可以復原的操作'); return; }
  history.future.push({ label: h.label, snap: snapshot() });
  restoreSnap(h.snap); afterChange();
  toast(`已復原：${h.label}`, [], 'undo');
}
function redo() {
  const h = history.future.pop();
  if (!h) { toast('沒有可以重做的操作'); return; }
  history.past.push({ label: h.label, snap: snapshot() });
  restoreSnap(h.snap); afterChange();
  toast(`已重做：${h.label}`, [], 'undo');
}
function afterChange() {
  if (state.editing >= 0) state.editing = -1;
  if (state.selected >= state.cues.length) state.selected = -1;
  renderCues(); markWaveDirty(); save.request(); updateUndoButtons();
}
function updateUndoButtons() {
  $('btnUndo').disabled = !history.past.length;
  $('btnRedo').disabled = !history.future.length;
  $('btnUndo').title = history.past.length ? `復原：${history.past[history.past.length - 1].label}（Ctrl+Z）` : '復原（Ctrl+Z）';
  $('btnRedo').title = history.future.length ? `重做：${history.future[history.future.length - 1].label}（Ctrl+Shift+Z）` : '重做（Ctrl+Shift+Z）';
}

// ========== 存檔：合併短時間內的多次修改，離開前一定寫完 ==========
const save = (() => {
  let timer = null, pending = false, lastSaved = null;
  function status(kind) {
    const el = $('saveStatus');
    if (!el) return;
    el.className = 'save-status ' + kind;
    el.textContent = kind === 'saving' ? '儲存中…' : kind === 'pending' ? '未儲存' : kind === 'error' ? '儲存失敗' : (lastSaved ? `已儲存 ${lastSaved}` : '');
  }
  async function flush() {
    clearTimeout(timer); timer = null;
    if (!pending || !state.name) return;
    pending = false;
    status('saving');
    try {
      const r = await api.save_project(state.name, state.cues, state.style, state.scenes);
      if (r && r.error) throw new Error(r.error);
      lastSaved = new Date().toLocaleTimeString('zh-TW', { hour12: false });
      status('saved');
    } catch (e) { pending = true; status('error'); toast('儲存失敗：' + (e.message || e)); }
  }
  return {
    request(delay = 400) { pending = true; status('pending'); clearTimeout(timer); timer = setTimeout(flush, delay); },
    flush, status, get pending() { return pending; },
  };
})();
// 關閉視窗時後端會先把目前資料要走直接寫檔（gui.py on_closing）
window.__asDumpProject = () => (state.name ? JSON.stringify({ name: state.name, cues: state.cues, style: state.style, scenes: state.scenes }) : null);
window.__asFlushSave = () => save.flush();
document.addEventListener('visibilitychange', () => { if (document.hidden) save.flush(); });
window.addEventListener('pagehide', () => save.flush());

// ========== 主頁：專案列表 ==========
let pickedMedia = null;
const basename = p => (p || '').split(/[\\/]/).pop();
const fmtDate = ts => { if (!ts) return ''; const d = new Date(ts * 1000); return d.toLocaleDateString('zh-TW') + ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }); };

async function showHome() {
  save.flush();
  $('editor').classList.add('hidden');
  $('home').classList.remove('hidden');
  const list = await api.list_projects();
  const box = $('projList');
  box.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<div class="empty-icon">🎬</div><b>還沒有專案</b><span>選一個影音檔，或把檔案拖進這個視窗，就會建立第一個專案。</span>';
    box.append(empty);
    return;
  }
  for (const p of list) {
    const card = document.createElement('button');
    card.className = 'proj-card';
    card.type = 'button';
    const name = Object.assign(document.createElement('b'), { textContent: p.name });
    const meta1 = Object.assign(document.createElement('span'), { className: 'meta', textContent: `${p.cue_count} 條字幕 · ${fmtDate(p.updated)}` });
    const meta2 = Object.assign(document.createElement('span'), { className: 'meta media', textContent: basename(p.media), title: p.media });
    const del = Object.assign(document.createElement('span'), { className: 'del', textContent: '刪除', role: 'button', tabIndex: 0 });
    card.append(name, meta1, meta2, del);
    card.onclick = e => { if (e.target === del) return; openProject(p.name); };
    const askDelete = async e => {
      e.stopPropagation();
      const ok = await confirmBox({ title: `刪除專案「${p.name}」？`, text: `${p.cue_count} 條字幕會一起刪除，影片檔不受影響。這個動作無法復原。`, ok: '刪除', danger: true });
      if (ok) { await api.delete_project(p.name); showHome(); toast(`已刪除專案「${p.name}」`); }
    };
    del.onclick = askDelete;
    del.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') askDelete(e); };
    box.append(card);
  }
}

async function createProject() {
  const name = $('npName').value.trim();
  if (!pickedMedia) { toast('請先選擇影音檔'); $('npPick').focus(); return; }
  if (!name) { toast('請輸入專案名稱'); $('npName').focus(); return; }
  const existing = (await api.list_projects()).some(p => p.name === name);
  if (existing) {
    const ok = await confirmBox({ title: `已有專案「${name}」`, text: '要覆蓋它嗎？原本的字幕會被清空。取消的話請改個名稱。', ok: '覆蓋', danger: true });
    if (!ok) return;
  }
  const r = await api.create_project(name, pickedMedia);
  if (r && r.error) { toast(r.error); return; }
  $('npName').value = ''; pickedMedia = null; $('npFile').textContent = '';
  openProject(name);
}

// 拖入檔案（由 shell.js / 後端轉來）：在專案列表就當作選好檔案並自動命名
window.__asEditorDrop = path => {
  if ($('editor').classList.contains('hidden')) {
    pickedMedia = path;
    $('npFile').textContent = basename(path);
    $('npFile').title = path;
    if (!$('npName').value.trim()) $('npName').value = basename(path).replace(/\.[^.]+$/, '');
    $('npCreate').focus();
    toast('已選好影音檔，按「建立專案」開始');
  } else toast('請先回到專案列表再拖入新檔案');
};

async function openProject(name) {
  const d = await api.open_project(name);
  if (d.error) { toast(d.error); return; }
  state.name = name;
  state.cues = normalizeCues(d.cues || []);
  state.scenes = d.scenes || [];
  state.marks = [];
  state.style = Object.assign(state.style, d.style || {});
  state.activeCue = state.selected = state.editing = -1;
  state.multi.clear(); state.view = { t0: 0, span: 0 };
  state.search = ''; $('searchBox').value = ''; state.onlyIssues = false;
  history.past.length = history.future.length = 0;
  $('projTitle').textContent = name;
  $('home').classList.add('hidden');
  $('editor').classList.remove('hidden');
  video.src = d.media_url || '';
  video.playbackRate = +$('speedSel').value || 1;
  state.waveform = null; state.duration = 0; peaksCache.key = null;
  api.get_waveform(name).then(wf => { state.waveform = wf; state.duration = wf.duration || 0; peaksCache.key = null; markWaveDirty(); updateSeekMax(); updateZoomLabel(); });
  syncStylePanel();
  renderCues(); markWaveDirty(); updateUndoButtons();
  save.status('saved');
}

// ========== 辨識 ==========
let jobPoll = null;
async function startTranscribe() {
  if (jobPoll) { toast('已有辨識進行中'); return; }
  if (state.cues.length) {
    const ok = await confirmBox({ title: '重新辨識？', text: `目前的 ${state.cues.length} 句字幕會全部被辨識結果取代。可以用「復原」拿回來，程式也會先留一份備份。`, ok: '重新辨識' });
    if (!ok) return;
  }
  await save.flush();
  const r = await api.start_transcribe(state.name, $('modelSize').value);
  if (r.error) { toast(r.error); return; }
  const before = snapshot();
  $('jobBar').classList.remove('hidden');
  $('btnTranscribe').classList.add('hidden');
  $('btnCancelJob').classList.remove('hidden');
  $('modelSize').disabled = true;
  const sc = window.__asCompute;
  const devChip = $('jobDevice');
  const devName = j => (j.device ? (sc ? sc.shortDev(j.device.device_label) : j.device.device_label) : '');
  const finish = () => {
    clearInterval(jobPoll); jobPoll = null;
    $('jobBar').classList.add('hidden'); $('jobStatus').classList.add('hidden'); devChip.classList.add('hidden');
    $('btnTranscribe').classList.remove('hidden'); $('btnCancelJob').classList.add('hidden');
    $('modelSize').disabled = false;
    if (sc && !sc.isRunning()) sc.renderDevice();
  };
  jobPoll = setInterval(async () => {
    const j = await api.get_job();
    $('jobFill').style.width = `${Math.round((j.progress || 0) * 100)}%`;
    if (j.status) { $('jobStatus').textContent = j.status; $('jobStatus').classList.remove('hidden'); }
    if (j.device) {
      devChip.textContent = devName(j);
      devChip.title = `${j.device.device_label}，${j.device.compute_type}`;
      devChip.className = 'dev-chip' + (j.device.device_used === 'cuda' ? ' gpu' : '');
      if (sc && !sc.isRunning()) sc.setSide((j.device.device_used === 'cuda' ? 'gpu' : 'cpu') + ' busy', '辨識中使用', devName(j), devChip.title);
    }
    if (j.state === 'done') {
      const used = devName(j); finish();
      const d = await api.open_project(state.name);
      history.past.push({ label: '辨識', snap: before });
      history.future.length = 0;
      state.cues = normalizeCues(d.cues || []);
      state.selected = -1;
      renderCues(); markWaveDirty(); updateUndoButtons(); save.status('saved');
      toast(`辨識完成：${state.cues.length} 條字幕${used ? `（${used}）` : ''}`);
    } else if (j.state === 'cancelled') {
      finish(); toast('已取消辨識');
    } else if (j.state === 'error') {
      finish(); toast('辨識失敗：' + friendlyError(j.error));
    }
  }, 400);
}
async function cancelTranscribe() {
  $('btnCancelJob').disabled = true;
  await api.cancel_transcribe();
  $('btnCancelJob').disabled = false;
}
window.__asEditorBusy = () => !!jobPoll;
window.__asOpenProject = name => openProject(name);

function friendlyError(msg) {
  const m = String(msg || '未知錯誤');
  if (/MemoryError|記憶體/.test(m)) return '記憶體不足，請改用較小的模型或關閉其他程式';
  if (/沒有音訊軌|no audio/i.test(m)) return '這個檔案沒有聲音軌';
  if (/FileNotFound|找不到/.test(m)) return '找不到影音檔，它可能被移動或刪除了';
  if (/連不上|下載|network|getaddrinfo/i.test(m)) return m.replace(/^RuntimeError:\s*/, '');
  return m.replace(/^\w+Error:\s*/, '');
}

// ========== 編輯區（字幕列表） ==========
const rows = new Map();   // 索引 → row 元素（只含目前顯示的）
let emptyEl = null;

function visibleIndices() {
  const q = state.search;
  const out = [];
  for (let i = 0; i < state.cues.length; i++) {
    const c = state.cues[i];
    if (q && !c.text.includes(q)) continue;
    if (state.onlyIssues && !cueInfo(i).issues.length) continue;
    out.push(i);
  }
  return out;
}

function renderCues() {
  const box = $('cueList');
  box.innerHTML = '';
  rows.clear();
  const idx = visibleIndices();
  if (!state.cues.length) {
    emptyEl = document.createElement('div');
    emptyEl.className = 'empty';
    emptyEl.innerHTML = '<div class="empty-icon">💬</div><b>還沒有字幕</b><span>按「開始辨識」自動聽打，或在波形區的空白處拖曳手動新增一句。</span>';
    const b = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: '開始辨識' });
    b.onclick = startTranscribe;
    emptyEl.append(b);
    box.append(emptyEl);
  } else if (!idx.length) {
    box.append(Object.assign(document.createElement('div'), { className: 'empty small', textContent: state.onlyIssues ? '沒有問題句 👍' : '沒有符合搜尋的字幕' }));
  }
  const frag = document.createDocumentFragment();
  for (const i of idx) frag.append(buildRow(i));
  box.append(frag);
  updateIssueButton();
}

function buildRow(i) {
  const c = state.cues[i];
  const info = cueInfo(i);
  const row = document.createElement('div');
  row.className = 'cue-row' + (i === state.activeCue ? ' active' : '') + (i === state.selected || state.multi.has(c.id) ? ' selected' : '') + (info.issues.length ? ' warn' : '');
  row.dataset.i = i;
  row.tabIndex = -1;
  const time = document.createElement('div');
  time.className = 'cue-time';
  time.title = '點擊修改時間';
  time.innerHTML = `<span class="ts">${fmtT(c.start)}</span><span class="arrow">→</span><span class="te">${fmtT(c.end)}</span>`;
  const meta = Object.assign(document.createElement('span'), { className: 'cue-meta', textContent: `${info.dur.toFixed(1)}s · ${info.cps.toFixed(1)}/s` });
  time.append(meta);
  const text = document.createElement('div');
  text.className = 'cue-text';
  const q = state.search;
  if (q) {
    c.text.split(q).forEach((part, k, arr) => {
      text.append(part);
      if (k < arr.length - 1) text.append(Object.assign(document.createElement('mark'), { textContent: q }));
    });
  } else text.textContent = c.text;
  const tools = document.createElement('div');
  tools.className = 'cue-tools';
  const tool = (a, label, title) => { const s = Object.assign(document.createElement('span'), { textContent: label, title, role: 'button', tabIndex: 0 }); s.dataset.a = a; return s; };
  if (info.issues.length) tools.append(Object.assign(document.createElement('span'), { className: 'warn-dot', textContent: '⚠', title: info.issues.join('\n') }));
  tools.append(tool('edit', '編輯', '編輯文字（Enter）'), tool('ins', '＋', '在此之後插入一句'), tool('merge', '⇧併', '與上一句合併'), tool('del', '✕', '刪除（Delete）'));
  row.append(time, text, tools);
  row.onclick = e => {
    const a = e.target.dataset?.a;
    if (a === 'merge') mergeCue(i);
    else if (a === 'del') deleteCue(i);
    else if (a === 'edit') editCue(i);
    else if (a === 'ins') insertAfter(i);
    else if (e.target.closest('.cue-time') && !e.target.closest('.cue-meta')) editTime(i);
    else if (e.shiftKey) { selectRange(i); }
    else if (e.ctrlKey || e.metaKey) { toggleMulti(i); }
    else { selectCue(i); video.currentTime = c.start + 0.01; }
  };
  row.ondblclick = e => { if (!e.target.dataset?.a && !e.target.closest('.cue-time')) editCue(i); };
  rows.set(i, row);
  return row;
}

function updateRow(i) {
  const old = rows.get(i);
  if (!old) return;
  const fresh = buildRow(i);
  old.replaceWith(fresh);
  if (i > 0 && rows.get(i - 1)) { const prev = buildRow(i - 1); rows.get(i - 1).replaceWith(prev); }   // 間隔／重疊狀態會變
  updateIssueButton();
}
function updateIssueButton() {
  const n = issueCount();
  const b = $('btnIssues');
  b.textContent = n ? `問題句 ${n}` : '問題句';
  b.classList.toggle('on', state.onlyIssues);
  b.disabled = !n && !state.onlyIssues;
}

function selectCue(i, scroll = false, keepMulti = false) {
  if (!keepMulti && state.multi.size) { state.multi.clear(); renderMultiBar(); rows.forEach(r => r.classList.remove('selected')); }
  const prev = rows.get(state.selected);
  if (prev) prev.classList.remove('selected');
  state.selected = i;
  markWaveDirty();
  const row = rows.get(i);
  if (row) { row.classList.add('selected'); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
}

// ----- 文字編輯 -----
function editCue(i) {
  if (state.editing >= 0) commitEdit();
  const row = rows.get(i);
  if (!row) { state.editing = -1; return; }   // 搜尋過濾下該列不在畫面上
  state.editing = i;
  selectCue(i);
  const c = state.cues[i];
  const ta = Object.assign(document.createElement('textarea'), { className: 'cue-edit', value: c.text, rows: 1 });
  ta.dataset.old = c.text;
  row.querySelector('.cue-text').replaceWith(ta);
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  ta.oninput = grow;
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); grow();
  ta.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) { e.preventDefault(); commitEdit(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); splitCue(i, ta.selectionStart, ta.value); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const next = nextVisibleIndex(i, e.shiftKey ? -1 : 1);
      commitEdit();
      if (next >= 0) editCue(next);
    }
    else if (e.key === 'Escape') { state.editing = -1; renderCues(); rows.get(i)?.focus(); }
    else if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0 && i > 0) { e.preventDefault(); commitEdit(); mergeCue(i); }
  };
  ta.onblur = () => { if (state.editing === i) commitEdit(); };
}

function commitEdit() {
  const i = state.editing;
  if (i < 0) return;
  state.editing = -1;
  const ta = document.querySelector('.cue-edit');
  if (!ta) return;
  const oldText = ta.dataset.old, newText = ta.value.trim();
  const changed = !!newText && newText !== oldText;
  if (changed) {
    commit('修改文字', () => { const c = state.cues[i]; c.words = alignWords(c, oldText, newText); c.text = newText; });
    api.learn_from_edit(oldText, newText).then(cands => {
      for (const w of cands) {
        toast(`把「${w}」加入詞庫？下次辨識會優先採用`, [
          { label: '加入', fn: async () => { await api.glossary_add(w); toast(`已加入詞庫：${w}`); } },
        ]);
      }
    });
  } else updateRow(i);
}

// 目前畫面上（搜尋過濾後）第 i 句的前一句／下一句索引；沒有就回 -1
function nextVisibleIndex(i, dir) {
  const idx = visibleIndices();
  const pos = idx.indexOf(i);
  if (pos < 0) return idx.length ? (dir > 0 ? idx[0] : idx[idx.length - 1]) : -1;
  const k = pos + dir;
  return k >= 0 && k < idx.length ? idx[k] : -1;
}

// ----- 時間編輯 -----
function editTime(i) {
  const row = rows.get(i);
  if (!row || row.querySelector('.time-edit')) return;
  const c = state.cues[i];
  const box = document.createElement('div');
  box.className = 'time-edit';
  const inS = Object.assign(document.createElement('input'), { value: fmtT(c.start, 3), title: '開始' });
  const inE = Object.assign(document.createElement('input'), { value: fmtT(c.end, 3), title: '結束' });
  const ok = Object.assign(document.createElement('button'), { className: 'btn sm primary', textContent: '確定' });
  const now = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: '用播放位置', title: '開始＝目前播放位置' });
  box.append(inS, '→', inE, ok, now);
  row.querySelector('.cue-time').replaceWith(box);
  inS.focus(); inS.select();
  const apply = () => {
    const s = parseT(inS.value), e = parseT(inE.value);
    if (Number.isNaN(s) || Number.isNaN(e)) { toast('時間格式看不懂，請寫成 1:02.500 或 62.5'); return; }
    if (e <= s) { toast('結束要晚於開始'); return; }
    commit('修改時間', () => { state.cues[i].start = s; state.cues[i].end = e; state.cues[i].words = remapWords(state.cues[i], state.cues[i].text); });
  };
  ok.onclick = apply;
  now.onclick = () => { inS.value = fmtT(video.currentTime, 3); inS.focus(); };
  for (const inp of [inS, inE]) inp.onkeydown = e => { if (e.key === 'Enter') apply(); else if (e.key === 'Escape') updateRow(i); };
}


// 改字後保留詞級時間戳：用最長共同子序列對齊新舊文字，沒改到的字沿用原本的時間，
// 新增的字在前後已知時間之間內插。中文以字為單位；英文再依空白組回單字。
function alignWords(cue, oldText, newText) {
  const oldWords = cue.words || [];
  const newChars = [...newText.replace(/\s/g, '')];
  if (!newChars.length) return [];
  if (!oldWords.length) return remapWords(cue, newText);
  const oc = [];   // 舊文字逐字的時間
  for (const [w, ws, we] of oldWords) {
    const chars = [...String(w).replace(/\s/g, '')];
    chars.forEach((ch, k) => oc.push({ ch, s: ws + (we - ws) * k / chars.length, e: ws + (we - ws) * (k + 1) / chars.length }));
  }
  const n = oc.length, m = newChars.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = oc[i].ch === newChars[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const times = new Array(m).fill(null);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (oc[i].ch === newChars[j]) { times[j] = [oc[i].s, oc[i].e]; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  // 內插沒有對到的字
  for (let j = 0; j < m; j++) {
    if (times[j]) continue;
    let a = j; while (a < m && !times[a]) a++;
    const left = j > 0 ? times[j - 1][1] : cue.start;
    const right = a < m ? times[a][0] : cue.end;
    const span = Math.max(0, right - left), cnt = a - j;
    for (let k = 0; k < cnt; k++) times[j + k] = [left + span * k / cnt, left + span * (k + 1) / cnt];
    j = a - 1;
  }
  const r3 = x => +Math.min(Math.max(x, cue.start), cue.end).toFixed(3);
  if (isCjk(newText)) return newChars.map((ch, k) => [ch, r3(times[k][0]), r3(times[k][1])]);
  const out = []; let k = 0;
  for (const tok of newText.split(/\s+/).filter(Boolean)) {
    const len = [...tok].length, s = times[k][0], e = times[k + len - 1][1];
    out.push([tok, r3(s), r3(e)]); k += len;
  }
  return out;
}

// 沒有原始詞級時間時的退路：等比分配（維持卡拉OK可用）
function remapWords(cue, newText) {
  const chars = [...newText.replace(/\s/g, '')];
  if (!chars.length) return [];
  const dur = cue.end - cue.start;
  return chars.map((ch, k) => [ch,
    +(cue.start + dur * k / chars.length).toFixed(3),
    +(cue.start + dur * (k + 1) / chars.length).toFixed(3)]);
}

function splitCue(i, caret, fullText) {
  const c = state.cues[i];
  const a = fullText.slice(0, caret).trim(), b = fullText.slice(caret).trim();
  if (!a || !b) { toast('游標要在句子中間才能斷句'); return; }
  const ratio = c.start + (c.end - c.start) * (caret / fullText.length);
  let tSplit = ratio;
  if (c.words?.length) {
    let n = 0;
    const target = a.replace(/\s/g, '').length;
    for (const [w, , we] of c.words) {
      n += w.length;
      if (n >= target) { tSplit = we; break; }   // 邊界 = 前半段最後一個詞的「終點」
    }
  }
  if (tSplit <= c.start || tSplit >= c.end) tSplit = ratio;
  commit('斷句', () => {
    const first = { start: c.start, end: round3(tSplit), text: a, words: [] };
    const second = { start: round3(tSplit), end: c.end, text: b, words: [] };
    const ws = c.words || [];
    const w1 = ws.filter(w => w[2] <= tSplit + 1e-3), w2 = ws.filter(w => w[2] > tSplit + 1e-3);
    first.words = w1.length ? alignWords({ ...first, words: w1 }, w1.map(w => w[0]).join(''), a) : remapWords(first, a);
    second.words = w2.length ? alignWords({ ...second, words: w2 }, w2.map(w => w[0]).join(''), b) : remapWords(second, b);
    state.cues.splice(i, 1, first, second);
  });
  selectCue(i + 1, true);
}

function mergeCue(i) {
  if (i <= 0) { toast('第一句沒有上一句可以合併'); return; }
  commit('合併字幕', () => {
    const prev = state.cues[i - 1], cur = state.cues[i];
    const sep = (isCjk(prev.text) || isCjk(cur.text)) ? '' : ' ';
    prev.text = (prev.text + sep + cur.text).trim();
    prev.end = Math.max(prev.end, cur.end);
    prev.words = [...(prev.words || []), ...(cur.words || [])];
    state.cues.splice(i, 1);
  });
  selectCue(i - 1, true);
}

function deleteCue(i) {
  const c = state.cues[i];
  commit('刪除字幕', () => { state.cues.splice(i, 1); });
  toast(`已刪除「${c.text.slice(0, 20)}${c.text.length > 20 ? '…' : ''}」`, [{ label: '復原', fn: undo }]);
  if (state.selected === i) selectCue(Math.min(i, state.cues.length - 1));
}

function insertAfter(i) {
  const c = state.cues[i], next = state.cues[i + 1];
  const start = c.end + 0.05;
  const end = next ? Math.min(start + 2, next.start - 0.05) : start + 2;
  if (end - start < MIN_DUR) { toast('與下一句之間沒有空間，請先調整時間'); return; }
  commit('新增字幕', () => { state.cues.splice(i + 1, 0, { start, end, text: '', words: [] }); });
  editCue(i + 1);
}

function addCueAtPlayhead() {
  const t = video.currentTime;
  const i = state.cues.findIndex(c => c.start > t);
  const next = i >= 0 ? state.cues[i] : null;
  const prev = i >= 0 ? state.cues[i - 1] : state.cues[state.cues.length - 1];
  const start = prev && t < prev.end ? prev.end + 0.05 : t;
  const end = next ? Math.min(start + 2, next.start - 0.05) : start + 2;
  if (end - start < MIN_DUR) { toast('這個位置沒有空間新增字幕'); return; }
  let idx = i >= 0 ? i : state.cues.length;
  commit('新增字幕', () => { state.cues.splice(idx, 0, { start, end, text: '', words: [] }); });
  editCue(idx);
}

// ----- 多選與批次 -----
function selectedIndices() {
  const ids = new Set(state.multi);
  if (!ids.size && state.selected >= 0 && state.cues[state.selected]) ids.add(state.cues[state.selected].id);
  return state.cues.map((c, i) => (ids.has(c.id) ? i : -1)).filter(i => i >= 0);
}
function toggleMulti(i) {
  const c = state.cues[i];
  if (!state.multi.size && state.selected >= 0 && state.cues[state.selected]) state.multi.add(state.cues[state.selected].id);
  if (state.multi.has(c.id)) state.multi.delete(c.id); else state.multi.add(c.id);
  state.selected = i;
  refreshSelection();
}
function selectRange(i) {
  const anchor = state.selected >= 0 ? state.selected : i;
  const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
  state.multi.clear();
  const vis = new Set(visibleIndices());
  for (let k = a; k <= b; k++) if (vis.has(k)) state.multi.add(state.cues[k].id);
  refreshSelection();
}
function selectAll() {
  state.multi = new Set(visibleIndices().map(i => state.cues[i].id));
  refreshSelection();
}
function refreshSelection() {
  rows.forEach((r, i) => r.classList.toggle('selected', i === state.selected || state.multi.has(state.cues[i].id)));
  renderMultiBar(); markWaveDirty();
}
function renderMultiBar() {
  const bar = $('multiBar');
  const n = state.multi.size;
  bar.classList.toggle('hidden', n < 2);
  $('multiCount').textContent = `已選 ${n} 句`;
}
function shiftSelected(ms) {
  const idx = selectedIndices();
  if (!idx.length) { toast('先選取字幕（Shift／Ctrl＋點擊，或 Ctrl+A 全選）'); return; }
  const dt = ms / 1000;
  const minStart = Math.min(...idx.map(i => state.cues[i].start));
  if (minStart + dt < 0) { toast('位移後會早於 0 秒'); return; }
  const ids = new Set(idx.map(i => state.cues[i].id));
  commit(`位移 ${idx.length} 句 ${ms > 0 ? '+' : ''}${ms} ms`, () => {
    for (const c of state.cues) if (ids.has(c.id)) {
      c.start += dt; c.end += dt;
      c.words = (c.words || []).map(([w, s, e]) => [w, +(s + dt).toFixed(3), +(e + dt).toFixed(3)]);
    }
  });
  state.multi = ids; refreshSelection();
  toast(`已位移 ${idx.length} 句（${ms > 0 ? '+' : ''}${ms} ms）`, [{ label: '復原', fn: undo }], 'shift');
}
function deleteSelected() {
  const idx = selectedIndices();
  if (idx.length <= 1) { if (idx.length) deleteCue(idx[0]); return; }
  const ids = new Set(idx.map(i => state.cues[i].id));
  commit(`刪除 ${idx.length} 句`, () => { state.cues = state.cues.filter(c => !ids.has(c.id)); });
  state.multi.clear(); renderMultiBar();
  toast(`已刪除 ${idx.length} 句`, [{ label: '復原', fn: undo }]);
}
function mergeSelected() {
  const idx = selectedIndices();
  if (idx.length < 2) { toast('至少選兩句才能合併'); return; }
  const first = idx[0], last = idx[idx.length - 1];
  if (last - first + 1 !== idx.length) { toast('只能合併相鄰的句子'); return; }
  commit(`合併 ${idx.length} 句`, () => {
    const part = state.cues.slice(first, last + 1);
    const cjk = part.some(c => isCjk(c.text));
    const merged = { start: part[0].start, end: Math.max(...part.map(c => c.end)),
      text: part.map(c => c.text.trim()).join(cjk ? '' : ' '), words: part.flatMap(c => c.words || []) };
    state.cues.splice(first, part.length, merged);
  });
  state.multi.clear(); renderMultiBar(); selectCue(first, true);
}

// ----- 匯入既有字幕 -----
async function importSubtitle() {
  if (!api.import_subtitle) { toast('這個版本不支援匯入'); return; }
  const r = await api.import_subtitle();
  if (!r || r.cancelled) return;
  if (r.error) { toast(r.error); return; }
  let mode = 'replace';
  if (state.cues.length) {
    const ok = await confirmBox({ title: `匯入「${r.name}」`, text: `檔案裡有 ${r.cues.length} 句。要取代目前的 ${state.cues.length} 句字幕嗎？（可以復原）`, ok: '取代' });
    if (!ok) return;
  }
  commit(`匯入字幕 ${r.name}`, () => { state.cues = r.cues.map(c => ({ ...c })); });
  toast(`已匯入 ${r.cues.length} 句字幕`, [{ label: '復原', fn: undo }]);
}

function replaceAll() {
  const q = $('searchBox').value, r = $('replaceBox').value;
  if (!q) { toast('請先輸入要搜尋的文字'); return; }
  let n = 0;
  commit(`全部取代「${q}」`, () => {
    for (const c of state.cues) {
      if (c.text.includes(q)) { const nt = c.text.split(q).join(r); c.words = alignWords(c, c.text, nt); c.text = nt; n++; }
    }
    if (!n) return false;
  });
  if (!n) { toast('沒有字幕包含這段文字'); return; }
  toast(`已取代 ${n} 條字幕`, [{ label: '復原', fn: undo }]);
  if (r.length >= 2 && r.length <= 8 && /[\p{L}\p{N}]/u.test(r)) {
    toast(`把「${r}」加入詞庫？`, [{ label: '加入', fn: async () => { await api.glossary_add(r); toast(`已加入詞庫：${r}`); } }]);
  }
}

// ========== 影片播放區：字幕覆疊 + 拖曳 + 安全框 ==========
function styleCss() {
  const s = state.style, scale = $('videoBox').clientHeight / 1080;
  return {
    fontFamily: `'${s.font}',sans-serif`,
    fontSize: `${Math.max(10, s.size * scale)}px`,
    color: s.color,
    webkitTextStroke: s.outline ? `${s.outline * scale}px ${s.outline_color}` : '',
    textShadow: s.outline ? `0 0 ${s.outline * scale * 2}px ${s.outline_color}` : '',
    paintOrder: 'stroke fill',
  };
}

// 二分搜尋：目前時間落在哪一句（cues 依 start 排序）
function findCue(t) {
  const cs = state.cues;
  let lo = 0, hi = cs.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cs[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  for (let i = k; i >= 0 && i > k - 3; i--) if (t >= cs[i].start && t <= cs[i].end) return i;   // 允許少量重疊
  return -1;
}

let lastOverlayKey = '';
function renderOverlay(t) {
  const ov = $('subOverlay');
  const i = findCue(t);
  if (i !== state.activeCue) {
    const prev = rows.get(state.activeCue);
    if (prev) prev.classList.remove('active');
    state.activeCue = i;
    const row = rows.get(i);
    if (row) {
      row.classList.add('active');
      if (state.follow && Date.now() - state.userScrolledAt > 4000) row.scrollIntoView({ block: 'nearest' });
    }
  }
  if (i < 0) { if (lastOverlayKey !== '') { ov.textContent = ''; lastOverlayKey = ''; } return; }
  const c = state.cues[i];
  const karaoke = state.style.karaoke && c.words?.length;
  const key = `${i}|${c.text}|${karaoke ? t.toFixed(2) : ''}|${JSON.stringify(state.style)}|${$('videoBox').clientHeight}`;
  if (key === lastOverlayKey) return;
  lastOverlayKey = key;
  Object.assign(ov.style, styleCss());
  ov.style.left = `${state.style.pos_x * 100}%`;
  ov.style.top = `${state.style.pos_y * 100}%`;
  if (karaoke) {
    ov.innerHTML = '';
    for (const [w, ws] of c.words) {
      const sp = document.createElement('span');
      sp.textContent = w;
      if (t >= ws) { sp.style.color = state.style.karaoke_color; sp.className = 'k-on'; }
      ov.append(sp);
    }
  } else ov.textContent = c.text;
}

function setupOverlayDrag() {
  const ov = $('subOverlay'), box = $('videoBox');
  ov.onpointerdown = e => {
    e.preventDefault();
    ov.setPointerCapture(e.pointerId);
    const move = ev => {
      const r = box.getBoundingClientRect();
      let x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
      const snapY = safeSnapY();
      if (snapY !== null && Math.abs(y - snapY) < 0.04) y = snapY;
      if (Math.abs(x - 0.5) < 0.03) x = 0.5;
      state.style.pos_x = Math.min(0.95, Math.max(0.05, x));
      state.style.pos_y = Math.min(0.95, Math.max(0.05, y));
      lastOverlayKey = '';
      renderOverlay(video.currentTime);
    };
    ov.onpointermove = move;
    ov.onpointerup = () => { ov.onpointermove = ov.onpointerup = null; save.request(); };
  };
}

function updateSafeFrame() {
  const f = $('safeFrame'), on = $('safeToggle').checked, mode = $('safeMode').value;
  f.classList.toggle('hidden', !on);
  if (!on) return;
  if (mode === 'h') Object.assign(f.style, { left: '4%', top: '5%', width: '92%', height: '82%' });
  else Object.assign(f.style, { left: '18%', top: '6%', width: '58%', height: '74%' });
}
function safeSnapY() {
  if (!$('safeToggle').checked) return null;
  return $('safeMode').value === 'h' ? 0.82 : 0.74;
}

// ----- 播放控制 -----
let seeking = false;
function updateSeekMax() {
  const d = video.duration || state.duration || 0;
  $('seekBar').max = d ? d.toFixed(3) : 0;
  $('durLabel').textContent = fmtT(d);
}
function setupPlayback() {
  const bar = $('seekBar');
  bar.oninput = () => { seeking = true; video.currentTime = +bar.value; };
  bar.onchange = () => { seeking = false; };
  video.addEventListener('loadedmetadata', updateSeekMax);
  video.addEventListener('durationchange', updateSeekMax);
  video.addEventListener('play', () => { $('btnPlay').textContent = '暫停'; });
  video.addEventListener('pause', () => { $('btnPlay').textContent = '播放'; });
  $('btnPlay').onclick = togglePlay;
  $('speedSel').onchange = () => { video.playbackRate = +$('speedSel').value; };
  $('followToggle').onchange = () => { state.follow = $('followToggle').checked; };
  $('loopToggle').onchange = () => { state.loopCue = $('loopToggle').checked; };
  $('scrubToggle').onchange = () => { state.scrub = $('scrubToggle').checked; updateWaveHint(); };
  $('cueList').addEventListener('scroll', () => { state.userScrolledAt = Date.now(); }, { passive: true });
  $('cueList').addEventListener('wheel', () => { state.userScrolledAt = Date.now(); }, { passive: true });
}
function togglePlay() { if (video.paused) video.play().catch(() => {}); else video.pause(); }
function seekBy(dt) { video.currentTime = Math.max(0, Math.min((video.duration || state.duration || 0), video.currentTime + dt)); }

// ========== 波形區 ==========
const wave = $('wave');
const wctx = wave.getContext('2d');
let waveDrag = null;
let hoverPauseTimer = null;
let waveDirty = true;
const peaksCache = { key: null, canvas: document.createElement('canvas') };
const layerCanvas = document.createElement('canvas');
const theme = { bg: '#1c1c1e', fg: '#30d158', cue: 'rgba(90,180,255,.35)', cueActive: 'rgba(57,255,20,.45)', cueSel: 'rgba(255,214,10,.55)', stroke: 'rgba(255,255,255,.5)', scene: '#4aa8ff', mark: '#ffd84a', head: '#fff' };
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  if (v('--wave-bg')) theme.bg = v('--wave-bg');
  if (v('--wave-fg')) theme.fg = v('--wave-fg');
  if (v('--wave-head')) theme.head = v('--wave-head');
  if (v('--wave-stroke')) theme.stroke = v('--wave-stroke');
  peaksCache.key = null; markWaveDirty();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
function markWaveDirty() { waveDirty = true; }

// 時間軸 viewport：顯示 [t0, t0+span]；span=0 代表整段
function viewSpan() { const d = state.duration || 1; return state.view.span > 0 ? Math.min(state.view.span, d) : d; }
function viewT0() { const d = state.duration || 0, s = viewSpan(); return Math.min(Math.max(0, state.view.t0), Math.max(0, d - s)); }
function t2x(t) { return (t - viewT0()) / viewSpan() * wave.width; }
function x2t(x) {
  const t = viewT0() + x / wave.width * viewSpan();
  return Math.min(Math.max(0, t), state.duration || 0);
}
function px2dt(px) { return px / wave.width * viewSpan(); }   // 螢幕像素換成秒（磁吸、命中門檻用）
function setView(t0, span) {
  const d = state.duration || 0;
  if (!(span > 0) || span >= d) {             // 0 或超過整段：顯示全部
    state.view = { t0: 0, span: 0 };
    peaksCache.key = null; markWaveDirty(); updateZoomLabel();
    return;
  }
  span = Math.max(span, 2);
  state.view = { t0: Math.min(Math.max(0, t0), Math.max(0, d - span)), span: span >= d ? 0 : span };
  peaksCache.key = null; markWaveDirty(); updateZoomLabel();
}
function zoomBy(factor, centerT) {
  const span = viewSpan(), t0 = viewT0();
  const c = centerT ?? (video.currentTime || t0 + span / 2);
  const ns = span / factor;
  setView(c - (c - t0) * (ns / span), ns);
}
function updateZoomLabel() {
  const el = $('zoomLabel');
  if (!el) return;
  const d = state.duration || 0, s = viewSpan();
  el.textContent = !d || s >= d ? '全部' : s >= 60 ? `${(s / 60).toFixed(s >= 600 ? 0 : 1)} 分` : `${s.toFixed(s >= 10 ? 0 : 1)} 秒`;
}

function snapTime(t) {
  const targets = [...state.scenes, ...state.marks];
  for (const c of state.cues) { targets.push(c.start, c.end); }
  const thr = px2dt(8);
  let best = t, bd = thr;
  for (const g of targets) { const d = Math.abs(g - t); if (d < bd) { bd = d; best = g; } }
  return best;
}

function drawPeaks(W, H) {
  const key = `${W}x${H}:${state.waveform ? state.waveform.peaks?.length : 0}:${theme.bg}:${viewT0().toFixed(3)}:${viewSpan().toFixed(3)}`;
  if (peaksCache.key === key) return;
  const cv = peaksCache.canvas;
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = theme.bg;
  c.fillRect(0, 0, W, H);
  const wf = state.waveform;
  const midY = H * 0.62, ampH = H * 0.34;
  if (wf?.peaks?.length) {
    c.fillStyle = theme.fg;
    const n = wf.peaks.length, rate = wf.rate || (n / (state.duration || 1));
    const t0 = viewT0(), span = viewSpan();
    for (let x = 0; x < W; x++) {
      const k0 = Math.floor((t0 + x / W * span) * rate), k1 = Math.max(k0 + 1, Math.floor((t0 + (x + 1) / W * span) * rate));
      let mn = 0, mx = 0;
      for (let k = k0; k < k1 && k < n; k++) { const p = wf.peaks[k]; if (p) { if (p[0] < mn) mn = p[0]; if (p[1] > mx) mx = p[1]; } }
      c.fillRect(x, midY + mn * ampH, 1, Math.max(1, (mx - mn) * ampH));
    }
    // 時間刻度
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
    const minPx = 90 * (window.devicePixelRatio || 1);
    const step = steps.find(s => s / span * W >= minPx) || 1800;
    c.fillStyle = theme.stroke; c.font = `${11 * (window.devicePixelRatio || 1)}px system-ui`; c.textBaseline = 'bottom';
    for (let t = Math.ceil(t0 / step) * step; t <= t0 + span; t += step) {
      const x = (t - t0) / span * W;
      c.globalAlpha = 0.35; c.fillRect(x, H * 0.36, 1, H * 0.64); c.globalAlpha = 0.8;
      c.fillText(fmtT(t, step < 1 ? 1 : 0).replace(/\.0$/, ''), x + 3, H - 2);
    }
    c.globalAlpha = 1;
  }
  peaksCache.key = key;
}

function drawLayer(W, H) {
  layerCanvas.width = W; layerCanvas.height = H;
  const c = layerCanvas.getContext('2d');
  c.clearRect(0, 0, W, H);
  const top = 6, h = H * 0.28;
  state.cues.forEach((cue, i) => {
    const x = t2x(cue.start), w = Math.max(2, t2x(cue.end) - x);
    if (x > W || x + w < 0) return;
    c.fillStyle = i === state.selected || state.multi.has(cue.id) ? theme.cueSel : theme.cue;
    c.fillRect(x, top, w, h);
    c.strokeStyle = theme.stroke;
    c.strokeRect(x + 0.5, top + 0.5, w - 1, h - 1);
  });
  c.fillStyle = theme.scene;
  for (const s of state.scenes) { c.beginPath(); c.arc(t2x(s), H - 8, 4, 0, 7); c.fill(); }
  c.fillStyle = theme.mark;
  for (const m of state.marks) {
    const x = t2x(m);
    c.beginPath(); c.moveTo(x, H - 14); c.lineTo(x + 4, H - 8); c.lineTo(x, H - 2); c.lineTo(x - 4, H - 8); c.fill();
  }
  waveDirty = false;
}

let lastDraw = { t: -1, W: 0, H: 0, active: -2 };
function drawWave(force) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(wave.clientWidth * dpr), H = Math.round(wave.clientHeight * dpr);
  if (!W || !H) return;
  const t = video.currentTime || 0;
  if (!force && !waveDirty && lastDraw.t === t && lastDraw.W === W && lastDraw.H === H && lastDraw.active === state.activeCue) return;
  if (wave.width !== W) wave.width = W;
  if (wave.height !== H) wave.height = H;
  drawPeaks(W, H);
  if (waveDirty || lastDraw.W !== W || lastDraw.H !== H) drawLayer(W, H);
  wctx.drawImage(peaksCache.canvas, 0, 0);
  wctx.drawImage(layerCanvas, 0, 0);
  if (state.activeCue >= 0) {
    const cue = state.cues[state.activeCue];
    const x = t2x(cue.start), w = Math.max(2, t2x(cue.end) - x);
    wctx.fillStyle = theme.cueActive;
    wctx.fillRect(x, 6, w, H * 0.28);
  }
  wctx.fillStyle = theme.head;
  wctx.fillRect(t2x(t), 0, Math.max(1, 1.5 * dpr), H);
  lastDraw = { t, W, H, active: state.activeCue };
}

function waveHit(x, y) {
  const H = wave.height;
  if (y > 6 && y < 6 + H * 0.28) {
    const t = x2t(x);
    const grip = 5 * (window.devicePixelRatio || 1) + 3;
    for (let i = 0; i < state.cues.length; i++) {
      const c = state.cues[i];
      if (Math.abs(x - t2x(c.start)) < grip) return { mode: 'l', i };
      if (Math.abs(x - t2x(c.end)) < grip) return { mode: 'r', i };
      if (t > c.start && t < c.end) return { mode: 'move', i };
    }
    return { mode: 'new' };
  }
  return null;
}

function updateWaveHint() {
  $('waveHint').textContent = state.scrub ? '滑過試聽已開啟・拖曳字幕框調時間・空白處拖曳新增・雙擊放 Mark 點' : '按住 Alt 滑過試聽・拖曳字幕框調時間・空白處拖曳新增・雙擊放 Mark 點';
}

function setupWave() {
  const pos = e => { const r = wave.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  wave.onpointerdown = e => {
    const [x, y] = pos(e);
    const hit = waveHit(x, y);
    if (hit) {
      waveDrag = { ...hit, t0: x2t(x), moved: false, before: snapshot(), alt: e.altKey };
      if (hit.i !== undefined) selectCue(hit.i, true);
      wave.setPointerCapture(e.pointerId);
    } else {
      video.currentTime = x2t(x);
    }
  };
  wave.onpointermove = e => {
    const [x, y] = pos(e);
    if (waveDrag) {
      let t = snapTime(x2t(x));
      const d = waveDrag;
      d.moved = true;
      const cs = state.cues;
      if (d.mode === 'l') {
        const c = cs[d.i], prev = cs[d.i - 1];
        if (!d.alt && prev) t = Math.max(t, prev.end);
        c.start = round3(Math.min(t, c.end - MIN_DUR));
      } else if (d.mode === 'r') {
        const c = cs[d.i], next = cs[d.i + 1];
        if (!d.alt && next) t = Math.min(t, next.start);
        c.end = round3(Math.max(t, c.start + MIN_DUR));
      } else if (d.mode === 'move') {
        const c = cs[d.i], w = c.end - c.start;
        let dt = t - d.t0;
        if (!d.alt) {
          const prev = cs[d.i - 1], next = cs[d.i + 1];
          if (prev && c.start + dt < prev.end) dt = prev.end - c.start;
          if (next && c.end + dt > next.start) dt = next.start - c.end;
        }
        if (c.start + dt < 0) dt = -c.start;
        c.start = round3(c.start + dt); c.end = round3(c.start + w); d.t0 = t;
      } else if (d.mode === 'new') {
        d.tNew = t;
      }
      markWaveDirty();
      return;
    }
    const hit = waveHit(x, y);
    wave.style.cursor = hit ? (hit.mode === 'move' ? 'grab' : hit.mode === 'new' ? 'copy' : 'ew-resize') : 'crosshair';
    // 滑過試聽：要按住 Alt 或開啟開關，而且影片沒在播放時才會觸發
    if ((e.altKey || state.scrub) && y > wave.height * 0.4 && video.paused) {
      video.currentTime = x2t(x);
      video.play().catch(() => {});
      clearTimeout(hoverPauseTimer);
      hoverPauseTimer = setTimeout(() => video.pause(), 160);
    }
  };
  wave.onpointerup = () => {
    if (!waveDrag) return;
    const d = waveDrag; waveDrag = null;
    if (d.mode === 'new') {
      if (d.moved && d.tNew !== undefined) {
        const a = Math.min(d.t0, d.tNew), b = Math.max(d.t0, d.tNew);
        if (b - a > 0.2) {
          const cue = { start: round3(a), end: round3(b), text: '', words: [] };
          commit('新增字幕', () => { state.cues.push(cue); });
          const idx = state.cues.indexOf(cue);
          if (idx >= 0) editCue(idx);
        }
      }
      return;
    }
    if (!d.moved) return;
    // 拖曳期間直接改了 state.cues，這裡補上歷史紀錄
    const after = snapshot();
    restoreSnap(d.before);
    const cue = state.cues[d.i];
    commit('調整時間', () => { restoreSnap(after); });
    const idx = state.cues.findIndex(c => c.start === JSON.parse(after).cues[d.i].start && c.text === cue.text);
    if (idx >= 0) selectCue(idx);
  };
  wave.ondblclick = e => {
    const [x] = pos(e);
    const t = +x2t(x).toFixed(3);
    const near = state.marks.findIndex(m => Math.abs(m - t) < px2dt(6));
    if (near >= 0) state.marks.splice(near, 1); else state.marks.push(t);
    markWaveDirty();
  };
  wave.addEventListener('wheel', e => {
    if (!state.duration) return;
    e.preventDefault();
    const [x] = pos(e);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
      setView(viewT0() + d / wave.clientWidth * viewSpan(), viewSpan());
    } else zoomBy(e.deltaY < 0 ? 1.25 : 0.8, x2t(x));
  }, { passive: false });
  new ResizeObserver(() => { peaksCache.key = null; markWaveDirty(); drawWave(true); }).observe(wave);
}

function splitAtPlayhead() {
  const t = video.currentTime;
  const i = findCue(t);
  if (i < 0 || t <= state.cues[i].start + 0.05 || t >= state.cues[i].end - 0.05) { toast('播放位置不在任何一句的中間'); return; }
  const c = state.cues[i];
  const ratio = (t - c.start) / (c.end - c.start);
  const cut = Math.max(1, Math.round(c.text.length * ratio));
  splitCue(i, cut, c.text);
  toast('已在播放位置切開字幕');
}
function setSelectedEdge(which) {
  const i = state.selected >= 0 ? state.selected : state.activeCue;
  if (i < 0) { toast('先選一句字幕'); return; }
  const t = round3(video.currentTime);
  commit(which === 'start' ? '開始＝播放位置' : '結束＝播放位置', () => {
    const c = state.cues[i];
    if (which === 'start') { if (t >= c.end - MIN_DUR) return false; c.start = t; }
    else { if (t <= c.start + MIN_DUR) return false; c.end = t; }
    c.words = remapWords(c, c.text);
  }) || toast('時間不合理：開始要早於結束');
}

// ========== 樣式面板 & 樣式牆 ==========
function syncStylePanel() {
  const s = state.style;
  $('stFont').value = s.font;
  if ($('stFont').value !== s.font) { $('stFont').append(new Option(s.font, s.font)); $('stFont').value = s.font; }
  $('stSize').value = s.size; $('stOutline').value = s.outline;
  $('stColor').value = s.color; $('stOutlineColor').value = s.outline_color;
  $('stKaraoke').checked = !!s.karaoke; $('stKaraokeColor').value = s.karaoke_color;
}

function bindStylePanel() {
  const upd = () => {
    Object.assign(state.style, {
      font: $('stFont').value, size: +$('stSize').value, outline: +$('stOutline').value,
      color: $('stColor').value, outline_color: $('stOutlineColor').value,
      karaoke: $('stKaraoke').checked, karaoke_color: $('stKaraokeColor').value,
    });
    lastOverlayKey = '';
    save.request(800);
  };
  for (const id of ['stFont', 'stSize', 'stOutline', 'stColor', 'stOutlineColor', 'stKaraoke', 'stKaraokeColor'])
    $(id).oninput = upd;
  $('btnFont').onclick = async () => {
    const f = await api.pick_font();
    if (!f) return;
    const face = new FontFace(f.name, `url(${f.url})`);
    await face.load(); document.fonts.add(face);
    $('stFont').append(new Option(f.name, f.name));
    $('stFont').value = f.name; upd();
    toast(`已匯入字型：${f.name}（檔案留在你的電腦）`);
  };
  $('btnSaveStyle').onclick = async () => {
    const name = await promptBox('收藏目前樣式', '樣式名稱', '');
    if (!name) return;
    api.styles_save(name, { ...state.style });
    toast(`已收藏樣式：${name}`);
  };
}

// 取代原生 prompt() 的小輸入框
function promptBox(title, placeholder, value) {
  return new Promise(resolve => {
    const back = $('modalBack'), modal = $('modal');
    modal.innerHTML = '';
    const h = Object.assign(document.createElement('h2'), { textContent: title });
    const inp = Object.assign(document.createElement('input'), { className: 'field', placeholder, value });
    const row = Object.assign(document.createElement('div'), { className: 'actions' });
    const no = Object.assign(document.createElement('button'), { className: 'btn', textContent: '取消' });
    const ok = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: '確定' });
    row.append(no, ok); modal.append(h, inp, row);
    const done = v => { back.classList.add('hidden'); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(inp.value.trim() || null); } };
    no.onclick = () => done(null); ok.onclick = () => done(inp.value.trim() || null);
    back.classList.remove('hidden');
    document.addEventListener('keydown', key, true);
    inp.focus();
  });
}

// ========== 彈窗 ==========
function openModal(html) {
  $('modal').innerHTML = html;
  $('modalBack').classList.remove('hidden');
  const first = $('modal').querySelector('input, button');
  if (first) first.focus();
}
function closeModal() { $('modalBack').classList.add('hidden'); }
$('modalBack').onclick = e => { if (e.target.id === 'modalBack') closeModal(); };

async function showGlossary() {
  openModal(`<h2>詞庫（越用越準）</h2>
    <p class="exp-note">辨識時會優先採用這些寫法。修正字幕時也會自動提示加入。</p>
    <div style="display:flex;gap:8px"><input id="gloNew" class="field" placeholder="新增詞彙" style="flex:1"><button class="btn" id="gloAdd">加入</button></div>
    <div id="gloList"></div>`);
  const render = async () => {
    const ws = await api.glossary_list();
    $('gloList').innerHTML = '';
    if (!ws.length) $('gloList').innerHTML = '<p class="exp-note">還沒有詞彙。加入人名、產品名、專有名詞，辨識會更準。</p>';
    for (const w of ws) {
      const d = document.createElement('div');
      d.className = 'glo-item';
      const rm = Object.assign(document.createElement('button'), { className: 'btn sm ghost danger', textContent: '移除' });
      rm.onclick = async () => { await api.glossary_remove(w); render(); };
      d.append(Object.assign(document.createElement('b'), { textContent: w }), rm);
      $('gloList').append(d);
    }
  };
  const add = async () => { const v = $('gloNew').value.trim(); if (v) { await api.glossary_add(v); $('gloNew').value = ''; render(); } };
  $('gloAdd').onclick = add;
  $('gloNew').onkeydown = e => { if (e.key === 'Enter') add(); };
  render();
}

async function showStyles() {
  const items = await api.styles_list();
  openModal(`<h2>樣式牆</h2>
    <p class="exp-note">收藏過的字幕樣式，一鍵套用到目前專案。</p><div id="styleList"></div>`);
  const box = $('styleList');
  if (!items.length) box.innerHTML = '<p class="exp-note">還沒有收藏樣式。調好樣式後按「收藏目前樣式」。</p>';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'style-card';
    const prev = document.createElement('span');
    prev.className = 'prev';
    prev.textContent = it.name + '：打一句，就好看';
    Object.assign(prev.style, {
      fontFamily: it.style.font, color: it.style.color,
      webkitTextStroke: `${(it.style.outline || 0) / 2}px ${it.style.outline_color}`,
      background: '#333', padding: '4px 10px', borderRadius: '6px',
    });
    const apply = Object.assign(document.createElement('button'), { className: 'btn', textContent: '套用' });
    apply.onclick = () => { Object.assign(state.style, it.style); syncStylePanel(); lastOverlayKey = ''; save.request(); toast(`已套用樣式：${it.name}`); };
    const del = Object.assign(document.createElement('button'), { className: 'btn sm ghost danger', textContent: '刪除' });
    del.onclick = async () => { await api.styles_delete(it.name); showStyles(); };
    d.append(prev, apply, del);
    box.append(d);
  }
}

async function showExport() {
  const ff = await api.has_ffmpeg();
  const mac = /Mac/i.test(navigator.platform);
  const hint = mac ? 'brew install ffmpeg' : 'winget install Gyan.FFmpeg';
  openModal(`<h2>匯出</h2>
    <div class="exp-grid">
      <button class="btn" data-fmt="srt">SRT 字幕檔<br><small>Premiere / DaVinci / 剪映</small></button>
      <button class="btn" data-fmt="vtt">VTT 字幕檔<br><small>網頁播放器</small></button>
      <button class="btn" data-fmt="ass">ASS 字幕檔<br><small>帶樣式與逐字動態</small></button>
      <button class="btn" data-fmt="txt">逐字稿 TXT<br><small>會議記錄、文章</small></button>
    </div>
    <button class="btn primary" id="btnBurn">成品影片（把字幕燒進影片）</button>
    <p class="exp-note">${ff ? '✓ 已偵測到 ffmpeg，可輸出成品影片' : `未偵測到 ffmpeg，輸出成品影片前要先安裝：<code>${hint}</code>（字幕檔不受影響）`}</p>`);
  const n = issueCount();
  if (n) $('modal').insertAdjacentHTML('beforeend', `<p class="exp-note warn">有 ${n} 句標了問題（太快、太短、重疊…），匯出前可以先按工具列的「問題句」檢查。</p>`);
  document.querySelectorAll('[data-fmt]').forEach(b => {
    b.onclick = async () => {
      await save.flush();
      const r = await api.export_subtitle(state.name, b.dataset.fmt, state.style);
      if (!r || r.cancelled) return;
      if (r.ok) toast(`已匯出：${r.path}`, [{ label: '開啟資料夾', fn: () => api.open_folder && api.open_folder(r.path.replace(/[\\/][^\\/]*$/, '')) }]);
      else toast('匯出失敗：' + friendlyError(r.error || r.msg));
    };
  });
  $('btnBurn').onclick = async () => {
    if (!ff) { toast('請先安裝 ffmpeg：' + hint); return; }
    await save.flush();
    toast('燒錄中，請稍候…');
    const r = await api.burn_video(state.name, state.style);
    if (!r || r.cancelled) return;
    toast(r.ok ? `成品完成：${r.msg}` : `失敗：${friendlyError(r.msg || r.error)}`);
  };
}

function showKeys() {
  openModal(`<h2>快捷鍵</h2><table>
    <tr><td><kbd>Space</kbd> / <kbd>K</kbd></td><td>播放／暫停</td></tr>
    <tr><td><kbd>J</kbd> / <kbd>L</kbd></td><td>倒退／快轉 5 秒</td></tr>
    <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>前後 1 秒（<kbd>Shift</kbd> 0.1 秒）</td></tr>
    <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>選上一句／下一句並跳到它</td></tr>
    <tr><td><kbd>Enter</kbd></td><td>編輯選取的句子；編輯中按 Enter 確認</td></tr>
    <tr><td><kbd>Shift</kbd>+<kbd>Enter</kbd></td><td>編輯中換行</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td>編輯中在游標處斷句</td></tr>
    <tr><td><kbd>Backspace</kbd>（行首）</td><td>與上一句合併</td></tr>
    <tr><td><kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd></td><td>存檔並跳到下一句／上一句</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>取消編輯／關閉視窗</td></tr>
    <tr><td><kbd>Delete</kbd></td><td>刪除選取的句子</td></tr>
    <tr><td><kbd>[</kbd> / <kbd>]</kbd></td><td>選取句的開始／結束 ＝ 播放位置</td></tr>
    <tr><td><kbd>B</kbd></td><td>在播放位置切開字幕</td></tr>
    <tr><td><kbd>N</kbd></td><td>在播放位置新增一句</td></tr>
    <tr><td><kbd>M</kbd></td><td>在播放位置放／移除 Mark 點</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></td><td>復原／重做</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>F</kbd></td><td>搜尋字幕</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>立刻儲存</td></tr>
    <tr><td><kbd>Shift</kbd>／<kbd>Ctrl</kbd>+點擊</td><td>範圍選取／多選</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>A</kbd></td><td>全選（可批次位移、合併、刪除）</td></tr>
    <tr><td>滾輪（波形上）</td><td>縮放時間軸；<kbd>Shift</kbd>+滾輪左右捲動</td></tr>
    <tr><td><kbd>+</kbd> / <kbd>-</kbd> / <kbd>0</kbd></td><td>放大／縮小／顯示全部</td></tr>
    <tr><td><kbd>Alt</kbd>+滑過波形</td><td>即時試聽</td></tr>
    <tr><td>波形拖曳字幕框</td><td>調時間（按住 <kbd>Alt</kbd> 可越過相鄰句）</td></tr>
    <tr><td>波形空白處拖曳</td><td>新增字幕</td></tr></table>`);
}

// ========== 快捷鍵 ==========
function setupHotkeys() {
  document.addEventListener('keydown', e => {
    // 不在編輯畫面時不攔快捷鍵：切到逐字稿轉檔頁後 state.name 仍在，要再看畫面是否可見
    if (!state.name || $('view-editor').classList.contains('hidden') || $('editor').classList.contains('hidden')) return;
    const modalOpen = !$('modalBack').classList.contains('hidden');
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      if (typing && e.target.classList.contains('cue-edit')) return;   // 編輯框內的 Ctrl+Z 交給文字框
      e.preventDefault(); if (e.shiftKey) redo(); else undo(); return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (state.editing >= 0) commitEdit(); save.request(0); toast('已儲存'); return; }
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); $('searchBox').focus(); $('searchBox').select(); return; }
    if (mod && (e.key === 'a' || e.key === 'A') && !typing && !modalOpen) { e.preventDefault(); selectAll(); return; }
    if (e.key === 'Escape') {
      if (modalOpen) { closeModal(); return; }
      if (typing) { e.target.blur(); return; }
      selectCue(-1); refreshSelection(); return;
    }
    if (typing || modalOpen || state.editing >= 0) return;
    switch (e.code) {
      case 'Space': case 'KeyK': e.preventDefault(); togglePlay(); break;
      case 'KeyJ': e.preventDefault(); seekBy(-5); break;
      case 'KeyL': e.preventDefault(); seekBy(5); break;
      case 'ArrowLeft': e.preventDefault(); seekBy(e.shiftKey ? -0.1 : -1); break;
      case 'ArrowRight': e.preventDefault(); seekBy(e.shiftKey ? 0.1 : 1); break;
      case 'ArrowUp': case 'ArrowDown': {
        e.preventDefault();
        const cur = state.selected >= 0 ? state.selected : state.activeCue;
        const n = cur < 0 ? (e.code === 'ArrowDown' ? nextVisibleIndex(-1, 1) : nextVisibleIndex(-1, -1)) : nextVisibleIndex(cur, e.code === 'ArrowDown' ? 1 : -1);
        if (n >= 0) { selectCue(n, true); video.currentTime = state.cues[n].start + 0.01; }
        break;
      }
      case 'Enter': { const i = state.selected >= 0 ? state.selected : state.activeCue; if (i >= 0) { e.preventDefault(); editCue(i); } break; }
      case 'Delete': { if (state.multi.size > 1) { e.preventDefault(); deleteSelected(); } else { const i = state.selected; if (i >= 0) { e.preventDefault(); deleteCue(i); } } break; }
      case 'Equal': case 'NumpadAdd': e.preventDefault(); zoomBy(1.5); break;
      case 'Minus': case 'NumpadSubtract': e.preventDefault(); zoomBy(1 / 1.5); break;
      case 'Digit0': e.preventDefault(); setView(0, 0); break;
      case 'BracketLeft': e.preventDefault(); setSelectedEdge('start'); break;
      case 'BracketRight': e.preventDefault(); setSelectedEdge('end'); break;
      case 'KeyB': e.preventDefault(); splitAtPlayhead(); break;
      case 'KeyN': e.preventDefault(); addCueAtPlayhead(); break;
      case 'KeyM': {
        e.preventDefault();
        const t = +video.currentTime.toFixed(3);
        const near = state.marks.findIndex(m => Math.abs(m - t) < 0.2);
        if (near >= 0) state.marks.splice(near, 1); else state.marks.push(t);
        markWaveDirty(); break;
      }
      case 'Home': e.preventDefault(); video.currentTime = 0; break;
      case 'End': e.preventDefault(); video.currentTime = video.duration || state.duration || 0; break;
      default: break;
    }
  });
}

// ========== 初始化 ==========
(async function init() {
  await initApi();
  readTheme();

  $('npPick').onclick = async () => {
    const p = await api.pick_media();
    if (!p) return;
    pickedMedia = p;
    $('npFile').textContent = basename(p); $('npFile').title = p;
    if (!$('npName').value.trim()) $('npName').value = basename(p).replace(/\.[^.]+$/, '');
    $('npName').focus(); $('npName').select();
  };
  $('npCreate').onclick = createProject;
  $('npName').onkeydown = e => { if (e.key === 'Enter') createProject(); };
  $('btnBack').onclick = () => { if (state.editing >= 0) commitEdit(); state.name = null; showHome(); };
  $('btnTranscribe').onclick = startTranscribe;
  $('btnCancelJob').onclick = cancelTranscribe;
  $('btnScenes').onclick = async () => {
    toast('偵測切點中…');
    state.scenes = await api.detect_scenes(state.name);
    markWaveDirty(); save.request();
    toast(`找到 ${state.scenes.length} 個剪輯切點（藍點）`);
  };
  $('btnReplace').onclick = replaceAll;
  $('searchBox').oninput = () => { state.search = $('searchBox').value; renderCues(); };
  $('searchBox').onkeydown = e => { if (e.key === 'Enter') { const n = nextVisibleIndex(state.selected, 1); if (n >= 0) { selectCue(n, true); video.currentTime = state.cues[n].start + 0.01; } } };
  $('btnIssues').onclick = () => { state.onlyIssues = !state.onlyIssues; renderCues(); };
  $('btnUndo').onclick = undo;
  $('btnImport').onclick = importSubtitle;
  $('zoomIn').onclick = () => zoomBy(1.5);
  $('zoomOut').onclick = () => zoomBy(1 / 1.5);
  $('zoomFit').onclick = () => setView(0, 0);
  $('multiShift').onclick = () => { const ms = parseInt($('multiMs').value, 10); if (!Number.isFinite(ms) || !ms) { toast('請輸入位移的毫秒數，例如 -300 或 500'); return; } shiftSelected(ms); };
  $('multiMs').onkeydown = e => { if (e.key === 'Enter') $('multiShift').click(); };
  $('multiMerge').onclick = mergeSelected;
  $('multiDelete').onclick = deleteSelected;
  $('multiClear').onclick = () => { state.multi.clear(); refreshSelection(); };
  $('btnRedo').onclick = redo;
  $('btnGlossary').onclick = showGlossary;
  $('btnStyles').onclick = showStyles;
  $('btnKeys').onclick = showKeys;
  $('btnExport').onclick = showExport;
  $('safeToggle').onchange = updateSafeFrame;
  $('safeMode').onchange = updateSafeFrame;

  bindStylePanel();
  setupOverlayDrag();
  setupWave();
  setupPlayback();
  setupHotkeys();
  updateWaveHint();
  updateUndoButtons();

  (function loop() {
    if (state.name && !$('editor').classList.contains('hidden')) {
      const t = video.currentTime || 0;
      if (state.loopCue && state.activeCue >= 0 && !video.paused) {
        const c = state.cues[state.activeCue];
        if (t > c.end) video.currentTime = c.start;
      }
      $('timeLabel').textContent = fmtT(t);
      if (!seeking) $('seekBar').value = t;
      renderOverlay(t);
      if (state.view.span > 0 && !waveDrag) {
        const t0 = viewT0(), s = viewSpan();
        if (t < t0 || t > t0 + s) setView(t - s * 0.1, s);          // 播放頭跑出畫面就翻頁
      }
      drawWave(false);
    }
    requestAnimationFrame(loop);
  })();

  showHome();
})();
