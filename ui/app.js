/* 字幕工房 — 編輯器邏輯（原生 JS，無框架）
 * 後端：window.pywebview.api；瀏覽器直接開啟時退回 mock（方便開發測試）。
 * 側欄切換與逐字稿轉檔在 shell.js（載入順序在本檔之後，共用這裡的 api / $ / toast / video）。 */
'use strict';

// ========== API（pywebview 或 mock） ==========
let api = null;

const mockApi = (() => {
  let cues = [], scenes = [4, 8, 12, 16], gloss = ['壹加壹'], styles = [];
  return {
    async _init() {
      try {
        const r = await fetch('../projects/demo/project.json');
        const d = await r.json();
        cues = d.cues || []; scenes = d.scenes?.length ? d.scenes : scenes;
      } catch (e) { /* 無 demo 專案時給空白 */ }
    },
    list_projects: async () => [{ name: 'demo', media: 'test_video.mp4', cue_count: cues.length, updated: Date.now() / 1000 }],
    open_project: async () => ({ name: 'demo', media: 'test_video.mp4', media_url: '../test_video.mp4', cues, style: {}, scenes }),
    create_project: async () => ({ ok: true }),
    save_project: async (n, c, s, sc) => { cues = c; return { ok: true }; },
    delete_project: async () => ({ ok: true }),
    pick_media: async () => (toast('mock 模式無法選檔'), null),
    pick_font: async () => (toast('mock 模式無法選字型'), null),
    start_transcribe: async () => ({ error: 'mock 模式不辨識，請用 python app.py 啟動' }),
    get_job: async () => ({ state: 'idle', progress: 0 }),
    get_waveform: async () => { try { return await (await fetch('../projects/demo/waveform.json')).json(); } catch (e) { return { duration: 16, rate: 50, peaks: [] }; } },
    detect_scenes: async () => scenes,
    glossary_list: async () => gloss,
    glossary_add: async w => (gloss.includes(w) ? { added: false } : (gloss.push(w), { added: true })),
    glossary_remove: async w => { gloss = gloss.filter(x => x !== w); return { ok: true }; },
    learn_from_edit: async (o, n) => {
      // 簡化版 diff：找出 new 有而 old 沒有的 2~8 字片段（正式版在後端）
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
  // pywebview 注入 API 後會發 pywebviewready；桌面程式（file://）冷啟動可能要幾秒，耐心等，
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
  waveform: null, duration: 0, activeCue: -1, editing: -1, search: '',
};
const video = $('video');

function toast(msg, actions = []) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.append(Object.assign(document.createElement('span'), { textContent: msg }));
  for (const a of actions) {
    const b = Object.assign(document.createElement('button'), { className: 'btn', textContent: a.label });
    b.onclick = () => { a.fn(); el.remove(); };
    el.append(b);
  }
  $('toasts').append(el);
  setTimeout(() => el.remove(), actions.length ? 8000 : 3500);
}

const fmtT = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// ========== 主頁 ==========
let pickedMedia = null;

async function showHome() {
  $('editor').classList.add('hidden');
  $('home').classList.remove('hidden');
  const list = await api.list_projects();
  const box = $('projList');
  box.innerHTML = '';
  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'proj-card';
    card.innerHTML = `<b></b><span class="meta">${p.cue_count} 條字幕</span><span class="meta media"></span><span class="del">刪除</span>`;
    card.querySelector('b').textContent = p.name;
    card.querySelector('.media').textContent = p.media.split(/[\\/]/).pop();
    card.onclick = () => openProject(p.name);
    card.querySelector('.del').onclick = async e => {
      e.stopPropagation();
      if (confirm(`刪除專案「${p.name}」？`)) { await api.delete_project(p.name); showHome(); }
    };
    box.append(card);
  }
}

async function openProject(name) {
  const d = await api.open_project(name);
  if (d.error) { toast(d.error); return; }
  state.name = name;
  state.cues = d.cues || [];
  state.scenes = d.scenes || [];
  state.style = Object.assign(state.style, d.style || {});
  $('projTitle').textContent = name;
  $('home').classList.add('hidden');
  $('editor').classList.remove('hidden');
  if (d.media_url) video.src = d.media_url;
  state.waveform = null;
  api.get_waveform(name).then(wf => { state.waveform = wf; state.duration = wf.duration; });
  syncStylePanel();
  renderCues();
}

const saveProject = (() => {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(() => api.save_project(state.name, state.cues, state.style, state.scenes), 600); };
})();

// ========== 辨識 ==========
async function startTranscribe() {
  const r = await api.start_transcribe(state.name, $('modelSize').value);
  if (r.error) { toast(r.error); return; }
  $('jobBar').classList.remove('hidden');
  const sc = window.__asCompute;
  const devChip = $('jobDevice');
  const devName = j => (j.device ? (sc ? sc.shortDev(j.device.device_label) : j.device.device_label) : '');
  const endDev = () => { devChip.classList.add('hidden'); if (sc && !sc.isRunning()) sc.renderDevice(); };
  const poll = setInterval(async () => {
    const j = await api.get_job();
    $('jobFill').style.width = `${Math.round(j.progress * 100)}%`;
    if (j.device) {
      devChip.textContent = devName(j);
      devChip.title = `${j.device.device_label}，${j.device.compute_type}`;
      devChip.className = 'dev-chip' + (j.device.device_used === 'cuda' ? ' gpu' : '');
      if (sc && !sc.isRunning()) sc.setSide((j.device.device_used === 'cuda' ? 'gpu' : 'cpu') + ' busy', '辨識中使用', devName(j), devChip.title);
    }
    if (j.state === 'done') {
      clearInterval(poll); $('jobBar').classList.add('hidden');
      const used = devName(j); endDev();
      const d = await api.open_project(state.name);
      state.cues = d.cues; renderCues();
      toast(`辨識完成：${state.cues.length} 條字幕${used ? `（${used}）` : ''}`);
    } else if (j.state === 'error') {
      clearInterval(poll); $('jobBar').classList.add('hidden'); endDev();
      toast('辨識失敗：' + j.error);
    }
  }, 500);
}

// ========== 編輯區（字幕列表） ==========
function renderCues() {
  const box = $('cueList');
  box.innerHTML = '';
  const q = state.search;
  state.cues.forEach((c, i) => {
    if (q && !c.text.includes(q)) return;
    const row = document.createElement('div');
    row.className = 'cue-row' + (i === state.activeCue ? ' active' : '');
    row.dataset.i = i;
    const time = Object.assign(document.createElement('div'), { className: 'cue-time', textContent: `${fmtT(c.start)} → ${fmtT(c.end)}` });
    const text = document.createElement('div');
    text.className = 'cue-text';
    if (q) {
      c.text.split(q).forEach((part, k, arr) => {
        text.append(part);
        if (k < arr.length - 1) text.append(Object.assign(document.createElement('mark'), { textContent: q }));
      });
    } else text.textContent = c.text;
    const tools = document.createElement('div');
    tools.className = 'cue-tools';
    tools.innerHTML = '<span data-a="merge" title="與上一句合併">⇧併</span><span data-a="del" title="刪除">✕</span>';
    row.append(time, text, tools);
    row.onclick = e => {
      const a = e.target.dataset?.a;
      if (a === 'merge') mergeCue(i);
      else if (a === 'del') { state.cues.splice(i, 1); renderCues(); saveProject(); }
      else { video.currentTime = c.start + 0.01; }
    };
    row.ondblclick = e => { if (!e.target.dataset?.a) editCue(i); };
    box.append(row);
  });
}

function editCue(i) {
  if (state.editing >= 0) commitEdit();
  state.editing = i;
  const row = $('cueList').querySelector(`[data-i="${i}"]`);
  if (!row) return;
  const c = state.cues[i];
  const input = Object.assign(document.createElement('input'), { className: 'cue-edit', value: c.text });
  input.dataset.old = c.text;
  row.querySelector('.cue-text').replaceWith(input);
  input.focus();
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); splitCue(i, input.selectionStart, input.value); }
    else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); editCue(Math.min(i + 1, state.cues.length - 1)); }
    else if (e.key === 'Escape') { state.editing = -1; renderCues(); }
    else if (e.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault(); commitEdit(); mergeCue(i);
    }
  };
  input.onblur = () => { if (state.editing === i) commitEdit(); };
}

async function commitEdit() {
  const i = state.editing;
  if (i < 0) return;
  state.editing = -1;
  const input = document.querySelector('.cue-edit');
  if (!input) return;
  const oldText = input.dataset.old, newText = input.value.trim();
  if (newText && newText !== oldText) {
    state.cues[i].text = newText;
    state.cues[i].words = remapWords(state.cues[i], newText);
    saveProject();
    const cands = await api.learn_from_edit(oldText, newText);
    for (const w of cands) {
      toast(`把「${w}」加入詞庫？下次辨識會優先採用`, [
        { label: '加入', fn: async () => { await api.glossary_add(w); toast(`已加入詞庫：${w}`); } },
      ]);
    }
  }
  renderCues();
}

// 文字改了之後，把詞級時間戳等比重新對映（維持卡拉OK可用）
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
  if (!a || !b) return;
  // 依字元比例決定切分時間（有詞級時間戳時用它更準）
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
  if (tSplit <= c.start || tSplit >= c.end) tSplit = ratio;  // 保險：退回比例切分
  const first = { start: c.start, end: +tSplit.toFixed(3), text: a, words: [] };
  const second = { start: +tSplit.toFixed(3), end: c.end, text: b, words: [] };
  first.words = remapWords(first, a);
  second.words = remapWords(second, b);
  state.cues.splice(i, 1, first, second);
  state.editing = -1;
  renderCues(); saveProject();
}

function mergeCue(i) {
  if (i <= 0) return;
  const prev = state.cues[i - 1], cur = state.cues[i];
  prev.text = prev.text + cur.text;
  prev.end = cur.end;
  prev.words = [...(prev.words || []), ...(cur.words || [])];
  state.cues.splice(i, 1);
  renderCues(); saveProject();
}

function replaceAll() {
  const q = $('searchBox').value, r = $('replaceBox').value;
  if (!q) return;
  let n = 0;
  for (const c of state.cues) {
    if (c.text.includes(q)) {
      c.text = c.text.split(q).join(r);
      c.words = remapWords(c, c.text);
      n++;
    }
  }
  renderCues(); saveProject();
  toast(`已取代 ${n} 條字幕`);
  if (r.length >= 2 && r.length <= 8) {
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

function renderOverlay(t) {
  const ov = $('subOverlay');
  const i = state.cues.findIndex(c => t >= c.start && t <= c.end);
  if (i !== state.activeCue) {
    state.activeCue = i;
    document.querySelectorAll('.cue-row.active').forEach(r => r.classList.remove('active'));
    const row = $('cueList').querySelector(`[data-i="${i}"]`);
    if (row) { row.classList.add('active'); row.scrollIntoView({ block: 'nearest' }); }
  }
  Object.assign(ov.style, styleCss());
  ov.style.left = `${state.style.pos_x * 100}%`;
  ov.style.top = `${state.style.pos_y * 100}%`;
  if (i < 0) { ov.textContent = ''; return; }
  const c = state.cues[i];
  if (state.style.karaoke && c.words?.length) {
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
      // 靠近安全框底線就吸附
      const snapY = safeSnapY();
      if (snapY !== null && Math.abs(y - snapY) < 0.04) y = snapY;
      if (Math.abs(x - 0.5) < 0.03) x = 0.5;   // 水平置中吸附
      state.style.pos_x = Math.min(0.95, Math.max(0.05, x));
      state.style.pos_y = Math.min(0.95, Math.max(0.05, y));
      renderOverlay(video.currentTime);
    };
    ov.onpointermove = move;
    ov.onpointerup = () => { ov.onpointermove = ov.onpointerup = null; saveProject(); };
  };
}

// 安全框：橫式（YouTube 進度條）/ 直式（Reels/TikTok 右側按鈕與底部）
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

// ========== 波形區 ==========
const wave = $('wave');
const wctx = wave.getContext('2d');
let waveDrag = null;   // {mode:'move'|'l'|'r'|'new', i, t0}
let hoverPauseTimer = null;

function t2x(t) { return t / (state.duration || 1) * wave.width; }
function x2t(x) {
  const t = x / wave.width * (state.duration || 1);
  return Math.min(Math.max(0, t), state.duration || 0);   // 夾限在影片長度內
}

function snapTime(t) {
  const targets = [...state.scenes, ...state.marks];
  for (const c of state.cues) { targets.push(c.start, c.end); }
  const thr = x2t(8);
  let best = t, bd = thr;
  for (const g of targets) { const d = Math.abs(g - t); if (d < bd) { bd = d; best = g; } }
  return best;
}

function drawWave() {
  const W = wave.clientWidth, H = wave.clientHeight;
  if (wave.width !== W) wave.width = W;
  if (wave.height !== H) wave.height = H;
  wctx.fillStyle = '#14141a';
  wctx.fillRect(0, 0, W, H);
  const wf = state.waveform;
  const midY = H * 0.62, ampH = H * 0.34;
  if (wf?.peaks?.length) {
    wctx.fillStyle = '#5ad46a';
    const n = wf.peaks.length;
    for (let x = 0; x < W; x++) {
      const k = Math.floor(x / W * n);
      const [mn, mx] = wf.peaks[k] || [0, 0];
      wctx.fillRect(x, midY + mn * ampH, 1, Math.max(1, (mx - mn) * ampH));
    }
  }
  // 字幕框（上半部橫條）
  state.cues.forEach((c, i) => {
    const x = t2x(c.start), w = Math.max(2, t2x(c.end) - x);
    wctx.fillStyle = i === state.activeCue ? 'rgba(57,255,20,.45)' : 'rgba(90,180,255,.35)';
    wctx.fillRect(x, 6, w, H * 0.28);
    wctx.strokeStyle = 'rgba(255,255,255,.5)';
    wctx.strokeRect(x + 0.5, 6.5, w - 1, H * 0.28 - 1);
  });
  // 切點藍點
  wctx.fillStyle = '#4aa8ff';
  for (const s of state.scenes) { wctx.beginPath(); wctx.arc(t2x(s), H - 8, 4, 0, 7); wctx.fill(); }
  // Mark 點（黃色菱形）
  wctx.fillStyle = '#ffd84a';
  for (const m of state.marks) {
    const x = t2x(m);
    wctx.beginPath(); wctx.moveTo(x, H - 14); wctx.lineTo(x + 4, H - 8); wctx.lineTo(x, H - 2); wctx.lineTo(x - 4, H - 8); wctx.fill();
  }
  // 播放頭
  wctx.fillStyle = '#fff';
  wctx.fillRect(t2x(video.currentTime), 0, 1.5, H);
}

function waveHit(x, y) {
  const H = wave.height;
  if (y > 6 && y < 6 + H * 0.28) {
    const t = x2t(x);
    for (let i = 0; i < state.cues.length; i++) {
      const c = state.cues[i];
      if (Math.abs(x - t2x(c.start)) < 5) return { mode: 'l', i };
      if (Math.abs(x - t2x(c.end)) < 5) return { mode: 'r', i };
      if (t > c.start && t < c.end) return { mode: 'move', i };
    }
    return { mode: 'new' };
  }
  return null;
}

function setupWave() {
  wave.onpointerdown = e => {
    const r = wave.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = waveHit(x, y);
    if (hit) {
      waveDrag = { ...hit, t0: x2t(x), moved: false };
      wave.setPointerCapture(e.pointerId);
    } else {
      video.currentTime = x2t(x);
    }
  };
  wave.onpointermove = e => {
    const r = wave.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (waveDrag) {
      const t = snapTime(x2t(x));
      const d = waveDrag;
      d.moved = true;
      if (d.mode === 'l') { const c = state.cues[d.i]; c.start = Math.min(t, c.end - 0.1); }
      else if (d.mode === 'r') { const c = state.cues[d.i]; c.end = Math.max(t, c.start + 0.1); }
      else if (d.mode === 'move') {
        const c = state.cues[d.i], w = c.end - c.start, dt = t - d.t0;
        c.start = +(c.start + dt).toFixed(3); c.end = +(c.start + w).toFixed(3); d.t0 = t;
      } else if (d.mode === 'new') {
        d.tNew = t;
      }
      return;
    }
    // 滑鼠掃過 → 即時試聽
    const hit = waveHit(x, y);
    wave.style.cursor = hit ? (hit.mode === 'move' ? 'grab' : hit.mode === 'new' ? 'copy' : 'ew-resize') : 'crosshair';
    if (y > wave.height * 0.4) {
      video.currentTime = x2t(x);
      video.play().catch(() => {});
      clearTimeout(hoverPauseTimer);
      hoverPauseTimer = setTimeout(() => video.pause(), 160);
    }
  };
  wave.onpointerup = e => {
    if (!waveDrag) return;
    const d = waveDrag; waveDrag = null;
    if (d.mode === 'new' && d.moved && d.tNew !== undefined) {
      const a = Math.min(d.t0, d.tNew), b = Math.max(d.t0, d.tNew);
      if (b - a > 0.2) {
        const cue = { start: +a.toFixed(3), end: +b.toFixed(3), text: '新字幕', words: [] };
        state.cues.push(cue);
        state.cues.sort((p, q) => p.start - q.start);
        renderCues();
        editCue(state.cues.indexOf(cue));
      }
    }
    renderCues(); saveProject();
  };
  wave.ondblclick = e => {
    const r = wave.getBoundingClientRect();
    const t = +x2t(e.clientX - r.left).toFixed(3);
    const near = state.marks.findIndex(m => Math.abs(m - t) < x2t(6));
    if (near >= 0) state.marks.splice(near, 1); else state.marks.push(t);
  };
}

function splitAtPlayhead() {
  const t = video.currentTime;
  const i = state.cues.findIndex(c => t > c.start + 0.05 && t < c.end - 0.05);
  if (i < 0) return;
  const c = state.cues[i];
  const ratio = (t - c.start) / (c.end - c.start);
  const cut = Math.max(1, Math.round(c.text.length * ratio));
  splitCue(i, cut, c.text);
  toast('已在播放位置切開字幕');
}

// ========== 樣式面板 & 樣式牆 ==========
function syncStylePanel() {
  const s = state.style;
  $('stFont').value = s.font;
  if ($('stFont').value !== s.font) {  // 自訂字型不在清單就補上
    $('stFont').append(new Option(s.font, s.font)); $('stFont').value = s.font;
  }
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
    saveProject();
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
  $('btnSaveStyle').onclick = () => {
    const name = prompt('樣式名稱？');
    if (!name) return;
    api.styles_save(name, { ...state.style });
    toast(`已收藏樣式：${name}`);
  };
}

// ========== 彈窗 ==========
function openModal(html) {
  $('modal').innerHTML = html;
  $('modalBack').classList.remove('hidden');
}
$('modalBack').onclick = e => { if (e.target.id === 'modalBack') $('modalBack').classList.add('hidden'); };

async function showGlossary() {
  const words = await api.glossary_list();
  openModal(`<h2>詞庫（越用越準）</h2>
    <p class="exp-note">辨識時會優先採用這些寫法。修正字幕時也會自動提示加入。</p>
    <div style="display:flex;gap:8px"><input id="gloNew" placeholder="新增詞彙" style="flex:1"><button class="btn" id="gloAdd">加入</button></div>
    <div id="gloList"></div>`);
  const render = async () => {
    const ws = await api.glossary_list();
    $('gloList').innerHTML = '';
    for (const w of ws) {
      const d = document.createElement('div');
      d.className = 'glo-item';
      d.append(Object.assign(document.createElement('b'), { textContent: w }),
               Object.assign(document.createElement('span'), { textContent: '移除' }));
      d.querySelector('span').onclick = async () => { await api.glossary_remove(w); render(); };
      $('gloList').append(d);
    }
  };
  $('gloAdd').onclick = async () => {
    const v = $('gloNew').value.trim();
    if (v) { await api.glossary_add(v); $('gloNew').value = ''; render(); }
  };
  render();
}

async function showStyles() {
  const items = await api.styles_list();
  openModal(`<h2>樣式牆</h2>
    <p class="exp-note">收藏過的字幕樣式，一鍵套用到目前專案。</p><div id="styleList"></div>`);
  const box = $('styleList');
  if (!items.length) box.innerHTML = '<p class="exp-note">還沒有收藏樣式——調好樣式後按「收藏目前樣式」。</p>';
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
    apply.onclick = () => { Object.assign(state.style, it.style); syncStylePanel(); saveProject(); toast(`已套用樣式：${it.name}`); };
    const del = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: '刪除' });
    del.onclick = async () => { await api.styles_delete(it.name); showStyles(); };
    d.append(prev, apply, del);
    box.append(d);
  }
}

async function showExport() {
  const ff = await api.has_ffmpeg();
  openModal(`<h2>匯出</h2>
    <div class="exp-grid">
      <button class="btn" data-fmt="srt">SRT 字幕檔<br><small>Premiere / DaVinci / 剪映</small></button>
      <button class="btn" data-fmt="vtt">VTT 字幕檔<br><small>網頁播放器</small></button>
      <button class="btn" data-fmt="ass">ASS 字幕檔<br><small>帶樣式與逐字動態</small></button>
      <button class="btn" data-fmt="txt">逐字稿 TXT<br><small>會議記錄、文章</small></button>
    </div>
    <button class="btn primary" id="btnBurn">成品影片（把字幕燒進影片）</button>
    <p class="exp-note">${ff ? '✓ 已偵測到 ffmpeg，可輸出成品影片' : '未偵測到 ffmpeg——安裝後才能輸出成品影片：winget install Gyan.FFmpeg（字幕檔不受影響）'}</p>`);
  document.querySelectorAll('[data-fmt]').forEach(b => {
    b.onclick = async () => {
      const r = await api.export_subtitle(state.name, b.dataset.fmt, state.style);
      if (r.ok) toast(`已匯出：${r.path}`);
    };
  });
  $('btnBurn').onclick = async () => {
    if (!ff) { toast('請先安裝 ffmpeg'); return; }
    toast('燒錄中，請稍候…');
    const r = await api.burn_video(state.name, state.style);
    toast(r.ok ? `成品完成：${r.msg}` : `失敗：${r.msg}`);
  };
}

function showKeys() {
  openModal(`<h2>快捷鍵</h2><table>
    <tr><td><kbd>雙擊字幕</kbd></td><td>編輯文字</td></tr>
    <tr><td><kbd>Enter</kbd></td><td>在游標處斷句</td></tr>
    <tr><td><kbd>Backspace</kbd>（行首）</td><td>與上一句合併</td></tr>
    <tr><td><kbd>Tab</kbd></td><td>存檔並跳到下一句</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>取消編輯</td></tr>
    <tr><td><kbd>Space</kbd></td><td>播放／暫停</td></tr>
    <tr><td><kbd>B</kbd></td><td>在播放位置切開字幕</td></tr>
    <tr><td><kbd>波形雙擊</kbd></td><td>放置／移除 Mark 點（可磁吸）</td></tr>
    <tr><td><kbd>波形拖曳空白</kbd></td><td>新增字幕</td></tr></table>`);
}

// ========== 初始化 ==========
(async function init() {
  await initApi();

  $('npPick').onclick = async () => {
    pickedMedia = await api.pick_media();
    $('npFile').textContent = pickedMedia || '';
  };
  $('npCreate').onclick = async () => {
    const name = $('npName').value.trim();
    if (!name || !pickedMedia) { toast('請輸入名稱並選擇影音檔'); return; }
    await api.create_project(name, pickedMedia);
    $('npName').value = ''; pickedMedia = null; $('npFile').textContent = '';
    openProject(name);
  };
  $('btnBack').onclick = () => { state.name = null; showHome(); };
  $('btnTranscribe').onclick = startTranscribe;
  $('btnScenes').onclick = async () => {
    toast('偵測切點中…');
    state.scenes = await api.detect_scenes(state.name);
    toast(`找到 ${state.scenes.length} 個剪輯切點（藍點）`);
  };
  $('btnReplace').onclick = replaceAll;
  $('searchBox').oninput = () => { state.search = $('searchBox').value; renderCues(); };
  $('btnGlossary').onclick = showGlossary;
  $('btnStyles').onclick = showStyles;
  $('btnKeys').onclick = showKeys;
  $('btnExport').onclick = showExport;
  $('btnPlay').onclick = () => video.paused ? video.play() : video.pause();
  $('safeToggle').onchange = updateSafeFrame;
  $('safeMode').onchange = updateSafeFrame;

  bindStylePanel();
  setupOverlayDrag();
  setupWave();

  document.addEventListener('keydown', e => {
    if (!state.name) return;   // 不在編輯畫面（例如逐字稿轉檔）時不攔快捷鍵
    if (state.editing >= 0 || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    else if (e.key === 'b' || e.key === 'B') splitAtPlayhead();
  });

  (function loop() {
    if (state.name) {
      $('timeLabel').textContent = fmtT(video.currentTime || 0);
      renderOverlay(video.currentTime || 0);
      drawWave();
    }
    requestAnimationFrame(loop);
  })();

  showHome();
})();
