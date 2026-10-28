/* 字幕工房 — 單一視窗外殼：側欄切換 + 逐字稿轉檔
 * 載入順序在 app.js 之後，共用它的 api / $ / toast / video。
 * 後端：gui.py 的 tx_* 方法；瀏覽器直開（沒有 pywebview）時用 mock 模擬進度，方便看版面。 */
'use strict';

(function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const VIEWS = ['transcribe', 'models', 'editor'];
  let tx = null;                 // 有 tx_* 方法的 api（pywebview 或 mock）
  const st = { files: [], queue: null, qIndex: 0, view: null, glossary: null, outdir: '', running: false, text: '', result: null, compute: null };
  // 辨識設定：逐字稿轉檔與字幕編輯器共用一份（存在 settings.json 的 recog），兩邊的表單同步顯示
  const recog = { v: { model: 'small', device: 'auto', lang: '', to_tw: true, use_glossary: true }, forms: new Set(), gloss: null };
  const RECOG_MODELS = [['tiny', 'tiny'], ['base', 'base'], ['small', 'small'], ['medium', 'medium'], ['large-v3-turbo', 'turbo'], ['large-v3', 'large']];

  // ---------- mock：模型清單（瀏覽器直開時看版面用） ----------
  const mockModels = (() => {
    const cat = [['tiny', '極速', 78.2e6, '最快、準確度最低，適合先試試看', true], ['base', '快速', 147.9e6, '速度快，適合收音清楚的錄音', true],
      ['small', '標準', 486.2e6, '速度與準確度平衡，一般電腦推薦', true], ['medium', '精準', 1530.6e6, '更準，用 CPU 會比較慢', false],
      ['large-v3-turbo', '高品質', 1621.7e6, '接近最高等級的準確度、速度接近「精準」，有顯示卡時推薦', false], ['large-v3', '最高', 3090.8e6, '最準也最慢，建議有顯示卡再用', false]];
    const ms = cat.map(([id, label, bytes, desc, dl]) => ({ id, label, bytes, desc, downloaded: dl, where: dl ? 'app' : null, size_on_disk: dl ? bytes : 0, partial: 0, downloading: null, error: null }));
    const timers = {};
    return {
      list: () => ({ root: 'C:\\Users\\you\\AppData\\Roaming\\AutoSubtitle\\models', models: ms, recommended: 'large-v3-turbo', used: ms.reduce((a, m) => a + m.size_on_disk, 0) }),
      download: id => {
        const m = ms.find(x => x.id === id); m.downloading = { done: 0, total: m.bytes, speed: 21e6 };
        timers[id] = setInterval(() => { m.downloading.done += 21e6 / 2; if (m.downloading.done >= m.bytes) { clearInterval(timers[id]); m.downloading = null; m.downloaded = true; m.where = 'app'; m.size_on_disk = m.bytes; } }, 500);
        return { ok: true };
      },
      cancel: id => { const m = ms.find(x => x.id === id); clearInterval(timers[id]); m.partial = m.downloading ? m.downloading.done : 0; m.downloading = null; return { ok: true }; },
      remove: id => { const m = ms.find(x => x.id === id); const freed = m.size_on_disk; Object.assign(m, { downloaded: false, where: null, size_on_disk: 0 }); return { ok: true, freed }; },
    };
  })();

  // ---------- 瀏覽器直開時的 mock：只為了看版面 ----------
  const txMock = (() => {
    let job = null, t0 = 0;
    const lines = ['大家好，今天要介紹的是本機離線語音辨識。', '影片不會上傳到任何雲端，也不需要登入。',
                   '選好檔案以後按開始轉檔，就會產出三種檔案。', '長影片可以只轉其中一段，省下等待時間。'];
    return {
      get_info: async () => ({ app: 'AutoSubtitle 字幕工房（mock）', initial_view: 'transcribe', outdir: 'E:\\AutoSubtitle\\output', models: ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'], ffmpeg: false,
        compute: { cuda_devices: 1, cuda_libs: true, gpu_ok: true, gpu_name: 'NVIDIA GeForce RTX 3080 Ti', reason: '', auto: 'cuda', cpu_label: 'CPU · 4 執行緒', gpu_label: 'GPU · NVIDIA GeForce RTX 3080 Ti', auto_label: 'GPU · NVIDIA GeForce RTX 3080 Ti', hint: 'pip install nvidia-cublas-cu12 nvidia-cudnn-cu12' } }),
      open_folder: async () => (toast('mock 模式無法開資料夾'), { ok: true }),
      models_list: async () => mockModels.list(),
      model_download: async id => mockModels.download(id),
      model_cancel: async id => mockModels.cancel(id),
      model_delete: async id => mockModels.remove(id),
      open_models_folder: async () => (toast('mock 模式無法開資料夾'), { ok: true }),
      about_info: async () => ({ version: '0.0.0-dev', dev: true, flavor: 'Windows', platform: 'Windows 11 (AMD64)', python: '3.12.3', frozen: false,
        data_dir: 'C:\\Users\\you\\AppData\\Roaming\\AutoSubtitle', models_dir: 'C:\\Users\\you\\AppData\\Roaming\\AutoSubtitle\\models',
        log_dir: 'C:\\Users\\you\\AppData\\Roaming\\AutoSubtitle\\logs', output_dir: 'C:\\Users\\you\\Documents\\AutoSubtitle', settings: { check_updates: true }, notices: null }),
      check_update: async () => ({ current: '1.0.0', latest: '1.1.0', newer: true, asset_name: 'AutoSubtitle-1.1.0-Windows-Setup.exe', asset_url: '#', url: '#' }),
      set_setting: async () => ({ ok: true }),
      open_url: async () => (toast('mock 模式不開網址'), { ok: true }),
      open_logs_folder: async () => (toast('mock 模式無法開資料夾'), { ok: true }),
      open_notices: async () => (toast('mock 模式'), { ok: true }),
      diagnostics: async () => 'AutoSubtitle 0.0.0-dev (mock)',
      copy_text: async () => ({ ok: false }),
      tx_pick_media: async () => ['E:\\影片\\會議錄影 2026-10-07.mp4'],
      tx_pick_folder: async () => ['E:\\影片\\課程\\第一週.mp4', 'E:\\影片\\課程\\第二週.mp4', 'E:\\影片\\課程\\第三週.m4a'],
      tx_expand: async ps => ps,
      tx_pick_glossary: async () => 'E:\\影片\\詞庫.txt',
      tx_pick_outdir: async () => 'E:\\影片\\輸出',
      tx_busy: async () => !!job && job.state === 'running',
      tx_start: async p => {
        const files = p.files || [p.src];
        job = { state: 'running', progress: 0, status: '載入模型中…', device: null, index: 0,
                queue: files.map(f => ({ name: f.split(/[\\/]/).pop(), src: f, state: 'pending', summary: null, error: null })),
                logs: [`辨識 ${files.length} 個檔案（模型 ${p.model}）`] };
        t0 = Date.now(); return { ok: true };
      },
      tx_cancel: async () => { if (job) { job.state = 'cancelled'; job.status = '已取消'; job.logs.push('已取消。'); } return { ok: true }; },
      tx_poll: async () => {
        if (!job) return { state: 'idle', progress: 0, status: '', logs: [], elapsed: 0 };
        const el = (Date.now() - t0) / 1000;
        if (job.state === 'running') {
          if (el > 1) job.device = { device_used: 'cuda', device_label: 'GPU · NVIDIA GeForce RTX 3080 Ti', compute_type: 'int8_float16', model: 'small' };
          const per = 3, i = Math.min(job.queue.length - 1, Math.floor(Math.max(0, el - 1) / per));
          job.queue.forEach((q, k) => { q.state = k < i ? 'done' : k === i ? 'running' : 'pending'; if (k < i) q.summary = `完成：${lines.length} 句`; });
          job.index = i; job.stage = 'transcribe';
          job.progress = Math.min(1, Math.max(0, (el - 1 - i * per) / per));
          if (i === job.queue.length - 1 && job.progress >= 1) {
            job.queue[i].state = 'done'; job.queue[i].summary = `完成：${lines.length} 句`;
            job.state = 'done'; job.status = job.queue.length > 1 ? `佇列完成：${job.queue.length} 個成功` : `完成：${lines.length} 句，語言 zh，耗時 ${el.toFixed(0)} 秒`; job.logs.push(job.status);
          }
        }
        return { ...job, queue: job.queue.map(q => ({ ...q })), elapsed: +el.toFixed(1), summary: job.state === 'done' ? job.status : null };
      },
      tx_result: async i => ({ name: job && job.queue[i == null ? job.queue.length - 1 : i].name,
        cues: lines.map((s, i) => ({ start: i * 4.2, end: i * 4.2 + 3.9, text: s, clock: `00:${String(i * 4).padStart(2, '0')}` })),
        files: ['E:\\AutoSubtitle\\output\\demo_逐字稿.txt', 'E:\\AutoSubtitle\\output\\demo_逐字稿_含時間.txt', 'E:\\AutoSubtitle\\output\\demo.srt'],
        outdir: 'E:\\AutoSubtitle\\output', text: lines.join('\n'), language: 'zh', model_used: 'small', elapsed: 5.2, summary: job.status,
      }),
    };
  })();

  // ---------- 側欄切換（同一視窗內切換，不開新視窗） ----------
  function showView(v) {
    if (!VIEWS.includes(v)) v = 'transcribe';
    for (const k of VIEWS) $('view-' + k).classList.toggle('hidden', k !== v);
    document.querySelectorAll('.nav-item[data-view]').forEach(b => {
      const on = b.dataset.view === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    if (v !== 'editor' && typeof video !== 'undefined' && video && !video.paused) video.pause();
    try { localStorage.setItem('as.view', v); } catch (e) { /* file:// 可能不給存 */ }
    if (v === 'models' && tx) refreshModels();
    if (v === 'transcribe' && tx) refreshGlossCount();     // 詞庫可能在編輯器改過
  }

  // ---------- 運算裝置顯示 ----------
  const shortDev = label => (label || '').replace(/NVIDIA\s+(GeForce\s+)?/i, '');

  // 依目前選擇算出「會用什麼」：{device:'cuda'|'cpu'|null, label, warn}
  function plannedDevice() {
    const c = st.compute, sel = recog.v.device;
    if (!c) return { device: null, label: '偵測中…', warn: '' };
    if (sel === 'cpu') return { device: 'cpu', label: c.cpu_label, warn: '' };
    if (c.gpu_ok) return { device: 'cuda', label: c.gpu_label, warn: '' };
    if (sel === 'cuda') return { device: null, label: '無法使用 GPU', warn: c.reason };
    return { device: 'cpu', label: c.cpu_label, warn: c.cuda_devices ? c.reason : '' };
  }

  function setSide(cls, cap, name, tip) {
    const el = $('sideCompute');
    el.className = 'compute ' + cls;
    $('sideComputeCap').textContent = cap;
    $('sideComputeName').textContent = name;
    el.title = tip || name;
  }

  function renderDevice() {
    const p = plannedDevice();
    if (!st.compute) return;
    for (const f of recog.forms) {
      const note = f.el('DeviceNote');
      if (p.device === 'cuda') {
        note.textContent = `將使用 ${shortDev(p.label)}`; note.className = 'device-note ok';
      } else if (p.device === 'cpu') {
        note.textContent = p.warn ? '將使用 CPU（GPU 缺少 CUDA 函式庫）' : `將使用 ${p.label}`;
        note.className = 'device-note' + (p.warn ? ' warn' : '');
      } else {
        note.textContent = '無法使用 GPU，請改選 CPU 或自動'; note.className = 'device-note warn';
      }
      note.title = p.warn || '';
    }
    if (!st.running) {
      const cls = p.device === 'cuda' ? 'gpu' : p.device === 'cpu' ? (p.warn ? 'warn' : 'cpu') : 'warn';
      setSide(cls, '目前運算', shortDev(p.label), p.warn || p.label);
    }
  }

  // 辨識中：顯示實際使用的裝置（模型載入後才知道）
  function showUsedDevice(dev) {
    const chip = $('txDevUsed');
    if (!dev) { chip.classList.add('hidden'); return; }
    chip.textContent = `${shortDev(dev.device_label)} · ${dev.compute_type}`;
    chip.title = `${dev.device_label}，${dev.compute_type}，模型 ${dev.model}`;
    chip.className = 'dev-chip' + (dev.device_used === 'cuda' ? ' gpu' : '');
    if (st.running) setSide((dev.device_used === 'cuda' ? 'gpu' : 'cpu') + ' busy', '辨識中使用', shortDev(dev.device_label), chip.title);
  }
  window.__asCompute = { shortDev, setSide, renderDevice, isRunning: () => st.running };

  // ---------- 共用：位元組、時間、確認對話框 ----------
  function fmtBytes(b) {
    if (!b) return '0 MB';
    return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
  }
  function fmtEta(s) {
    if (s == null || !isFinite(s)) return '';
    s = Math.max(0, Math.round(s));
    if (s < 60) return `剩約 ${Math.max(s, 1)} 秒`;
    const m = Math.round(s / 60);
    return m < 60 ? `剩約 ${m} 分` : `剩約 ${Math.floor(m / 60)} 小時 ${m % 60} 分`;
  }
  // 用自家彈窗取代原生 confirm()，回傳 Promise<boolean>
  function confirmDialog({ title, text, ok = '確定', cancel = '取消', danger = false }) {
    return new Promise(resolve => {
      const back = $('modalBack'), modal = $('modal');
      const prevClick = back.onclick;
      modal.innerHTML = '';
      modal.setAttribute('aria-modal', 'true');
      const h = Object.assign(document.createElement('h2'), { textContent: title, id: 'dlgTitle' });
      modal.setAttribute('aria-labelledby', 'dlgTitle');
      const p = Object.assign(document.createElement('p'), { textContent: text });
      const row = Object.assign(document.createElement('div'), { className: 'actions' });
      const bNo = Object.assign(document.createElement('button'), { className: 'btn', textContent: cancel });
      const bOk = Object.assign(document.createElement('button'), { className: 'btn ' + (danger ? 'danger' : 'primary'), textContent: ok });
      row.append(bNo, bOk);
      modal.append(h, p, row);
      back.classList.remove('hidden');
      const done = v => {
        back.classList.add('hidden');
        back.onclick = prevClick;
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
      };
      bNo.onclick = () => done(false);
      bOk.onclick = () => done(true);
      back.onclick = e => { if (e.target === back) done(false); };
      document.addEventListener('keydown', onKey, true);
      bOk.focus();
    });
  }
  window.__asConfirm = confirmDialog;

  // ---------- 模型管理 ----------
  const md = { list: [], root: '', recommended: 'small', used: 0, timer: null };
  const modelById = id => md.list.find(m => m.id === id);

  async function refreshModels() {
    let r;
    try { r = await tx.models_list(); } catch (e) { return; }
    if (!r) return;
    Object.assign(md, { list: r.models || [], root: r.root || '', recommended: r.recommended || 'small', used: r.used || 0 });
    renderModels();
    renderModelHint();
    const busy = md.list.some(m => m.downloading);
    const badge = $('navModelsBadge');
    const active = md.list.filter(m => m.downloading);
    if (active.length) {
      const d = active[0].downloading;
      badge.textContent = d.done ? `${Math.round(d.done / Math.max(d.total, 1) * 100)}%` : '…';
      badge.classList.remove('hidden');
    } else badge.classList.add('hidden');
    clearTimeout(md.timer);
    const visible = !$('view-models').classList.contains('hidden');
    if (busy || visible) md.timer = setTimeout(refreshModels, busy ? 500 : 3000);
  }

  function renderModels() {
    $('mdUsed').textContent = `模型共佔 ${fmtBytes(md.used)}`;
    $('mdRoot').textContent = ltr(md.root);
    $('mdRoot').title = md.root;
    const box = $('mdList');
    box.innerHTML = '';
    for (const m of md.list) {
      const row = document.createElement('div');
      row.className = 'card md-row';
      const main = Object.assign(document.createElement('div'), { className: 'md-main' });
      const title = Object.assign(document.createElement('div'), { className: 'md-title' });
      title.append(Object.assign(document.createElement('b'), { textContent: m.label }),
                   Object.assign(document.createElement('span'), { className: 'md-id', textContent: m.id }));
      if (m.id === md.recommended) title.append(Object.assign(document.createElement('span'), { className: 'badge rec', textContent: '推薦' }));
      if (m.downloaded) title.append(Object.assign(document.createElement('span'), { className: 'badge ok', textContent: '已下載' }));
      else if (m.partial && !m.downloading) title.append(Object.assign(document.createElement('span'), { className: 'badge part', textContent: `已下載 ${Math.round(m.partial / m.bytes * 100)}%，可續傳` }));
      main.append(title, Object.assign(document.createElement('div'), { className: 'md-desc', textContent: m.desc }));
      if (m.downloading) {
        const d = m.downloading, frac = d.total ? d.done / d.total : 0;
        const pr = Object.assign(document.createElement('div'), { className: 'md-progress' });
        const bar = Object.assign(document.createElement('div'), { className: 'progress' });
        const fill = Object.assign(document.createElement('div'), { className: 'fill' });
        fill.style.width = `${(frac * 100).toFixed(1)}%`;
        bar.append(fill);
        const eta = d.speed ? fmtEta((d.total - d.done) / d.speed) : '';
        pr.append(bar, Object.assign(document.createElement('span'), {
          textContent: d.done ? `${fmtBytes(d.done)} / ${fmtBytes(d.total)}${d.speed ? ` · ${(d.speed / 1e6).toFixed(1)} MB/s` : ''}${eta ? ` · ${eta}` : ''}`
                              : `連線中… · 共 ${fmtBytes(d.total)}` }));
        main.append(pr);
      }
      if (m.error) main.append(Object.assign(document.createElement('div'), { className: 'md-err', textContent: m.error }));
      const side = Object.assign(document.createElement('div'), { className: 'md-side' });
      side.append(Object.assign(document.createElement('span'), { className: 'md-size', textContent: fmtBytes(m.downloaded ? (m.size_on_disk || m.bytes) : m.bytes) }));
      const btn = document.createElement('button');
      if (m.downloading) {
        btn.className = 'btn sm'; btn.textContent = '取消';
        btn.onclick = async () => { btn.disabled = true; await tx.model_cancel(m.id); refreshModels(); };
      } else if (m.downloaded) {
        btn.className = 'btn sm ghost danger'; btn.textContent = '刪除';
        btn.title = m.where === 'hf-cache' ? '這個模型存在 Hugging Face 共用快取，刪除後其他程式也要重新下載' : '';
        btn.onclick = async () => {
          const ok = await confirmDialog({ title: `刪除「${m.label}」模型？`, danger: true, ok: '刪除',
            text: `會釋放約 ${fmtBytes(m.size_on_disk || m.bytes)}。之後要用時再下載即可。` + (m.where === 'hf-cache' ? '這個模型存在 Hugging Face 的共用快取，其他程式若也在用，同樣需要重新下載。' : '') });
          if (!ok) return;
          const r = await tx.model_delete(m.id);
          toast(r && r.ok ? `已刪除「${m.label}」，釋放 ${fmtBytes(r.freed)}` : (r && r.error) || '刪除失敗');
          refreshModels();
        };
      } else {
        btn.className = 'btn sm primary'; btn.textContent = m.partial ? '繼續下載' : '下載';
        btn.onclick = async () => { btn.disabled = true; const r = await tx.model_download(m.id); if (r && r.error) toast(r.error); refreshModels(); };
      }
      side.append(btn);
      row.append(main, side);
      box.append(row);
    }
  }

  // 逐字稿轉檔頁：模型旁邊顯示大小與是否已下載
  function renderModelHint() {
    const m = modelById(recog.v.model);
    const hint = !m ? '越大越準也越慢'
      : m.downloaded ? `${m.label} · ${m.desc} · 已下載`
      : m.downloading ? `${m.label} · 下載中 ${Math.round(m.downloading.done / m.bytes * 100)}%`
      : `${m.label} · ${m.desc} · 第一次使用需下載 ${fmtBytes(m.bytes)}`;
    for (const f of recog.forms) {
      f.el('Model').querySelectorAll('button[data-v]').forEach(b => {
        const x = modelById(b.dataset.v);
        b.classList.toggle('dl', !!(x && x.downloaded));
        if (x) b.title = `${x.label}：${x.desc}（${fmtBytes(x.bytes)}${x.downloaded ? '，已下載' : '，需下載'}）`;
      });
      f.el('ModelHint').textContent = hint;
    }
  }

  // ---------- 辨識設定（共用元件：逐字稿轉檔頁內嵌一份，字幕編輯器用彈窗開一份） ----------
  const LANGS = [['', '自動偵測'], ['zh', '中文'], ['en', '英文'], ['ja', '日文'], ['ko', '韓文']];
  const DEVICES = [['auto', '自動'], ['cuda', 'GPU（CUDA）'], ['cpu', 'CPU']];
  const opts = list => list.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  function recogMarkup(px) {
    return `
      <div class="row"><label class="lbl" id="${px}ModelLbl">模型</label><div class="inline">
        <div class="seg" id="${px}Model" role="radiogroup" aria-labelledby="${px}ModelLbl">${RECOG_MODELS.map(([v, l]) => `<button type="button" data-v="${v}" role="radio">${l}</button>`).join('')}</div>
        <span class="hint" id="${px}ModelHint">越大越準也越慢</span>
        <button id="${px}ModelsLink" class="btn sm ghost" type="button">管理模型</button>
      </div></div>
      <div class="row"><label class="lbl" for="${px}Lang">語言</label><div class="inline">
        <select id="${px}Lang" class="field">${opts(LANGS)}</select>
        <label class="lbl" for="${px}Device">運算</label>
        <select id="${px}Device" class="field">${opts(DEVICES)}</select>
        <span id="${px}DeviceNote" class="device-note" role="status"></span>
      </div></div>
      <div class="row"><label class="lbl" for="${px}Tw">台灣用語</label><div class="inline">
        <label class="switch"><input type="checkbox" id="${px}Tw"><span></span></label>
        <span class="hint">簡體轉繁體，並換成台灣慣用語</span>
      </div></div>
      <div class="row"><label class="lbl" for="${px}Gloss">我的詞庫</label><div class="inline">
        <label class="switch"><input type="checkbox" id="${px}Gloss"><span></span></label>
        <span class="hint" id="${px}GlossHint">辨識時優先採用字幕編輯器「詞庫」裡的詞</span>
      </div></div>`;
  }
  function mountRecog(box, px) {
    box.innerHTML = recogMarkup(px);
    const f = { box, px, el: id => box.querySelector('#' + px + id) };
    f.el('Model').onclick = e => { const b = e.target.closest('button[data-v]'); if (b && !b.disabled) setRecog({ model: b.dataset.v }); };
    f.el('Model').onkeydown = e => {          // radiogroup：左右鍵切換
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const ids = RECOG_MODELS.map(m => m[0]);
      const k = (ids.indexOf(recog.v.model) + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length;
      setRecog({ model: ids[k] });
      f.el('Model').querySelector(`[data-v="${ids[k]}"]`).focus();
    };
    f.el('Lang').onchange = e => setRecog({ lang: e.target.value });
    f.el('Device').onchange = e => setRecog({ device: e.target.value });
    f.el('Tw').onchange = e => setRecog({ to_tw: e.target.checked });
    f.el('Gloss').onchange = e => setRecog({ use_glossary: e.target.checked });
    f.el('ModelsLink').onclick = () => { closePanel(); showView('models'); };
    recog.forms.add(f);
    syncRecog();
    refreshGlossCount();
    return f;
  }
  const modelShort = id => (RECOG_MODELS.find(m => m[0] === id) || [id, id])[1];
  function setRecog(patch) {
    Object.assign(recog.v, patch);
    syncRecog();
    if (tx && tx.set_setting) Promise.resolve(tx.set_setting('recog', recog.v)).then(r => { if (r && r.error) toast(r.error); });
  }
  function syncRecog() {
    for (const f of recog.forms) {
      f.el('Model').querySelectorAll('button[data-v]').forEach(b => {
        const on = b.dataset.v === recog.v.model;
        b.classList.toggle('on', on); b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1;
      });
      f.el('Lang').value = recog.v.lang; f.el('Device').value = recog.v.device;
      f.el('Tw').checked = !!recog.v.to_tw; f.el('Gloss').checked = !!recog.v.use_glossary;
      const n = recog.gloss;
      f.el('GlossHint').textContent = n == null ? '辨識時優先採用字幕編輯器「詞庫」裡的詞'
        : n ? `辨識時優先採用字幕編輯器「詞庫」裡的 ${n} 個詞` : '詞庫是空的：在字幕編輯器按「詞庫」加入專有名詞';
    }
    const lbl = document.getElementById('recogLabel');
    if (lbl) lbl.textContent = modelShort(recog.v.model);
    renderModelHint(); renderDevice();
  }
  async function refreshGlossCount() {
    const fn = (tx && tx.glossary_list) || (api && api.glossary_list);
    if (!fn) return;
    try { const w = await fn(); recog.gloss = (w || []).length; } catch (e) { return; }
    syncRecog();
  }
  function openRecogPanel() {
    const modal = $('modal'), back = $('modalBack');
    modal.innerHTML = '';
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'recogTitle');
    const h = Object.assign(document.createElement('h2'), { id: 'recogTitle', textContent: '辨識設定' });
    const p = Object.assign(document.createElement('p'), { className: 'muted', textContent: '逐字稿轉檔與字幕編輯器共用這份設定，改一邊另一邊也會跟著改。' });
    const box = Object.assign(document.createElement('div'), { className: 'recog in-modal' });
    const actions = Object.assign(document.createElement('div'), { className: 'actions' });
    const close = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: '完成' });
    close.onclick = closePanel;
    actions.append(close);
    modal.append(h, p, box, actions);
    const f = mountRecog(box, 'ed');
    panelCleanup = () => recog.forms.delete(f);
    back.classList.remove('hidden');
    document.addEventListener('keydown', panelKey, true);
    f.el('Model').querySelector('.on').focus();
  }
  window.__asRecog = { get: () => ({ ...recog.v }), open: openRecogPanel };

  function bindModels() {
    $('mdOpen').onclick = () => tx.open_models_folder();
  }

  // ---------- 關於與更新 ----------
  async function checkUpdate(force) {
    let r;
    try { r = await tx.check_update(!!force); } catch (e) { return null; }
    const b = $('updateBanner');
    if (r && r.newer) {
      b.innerHTML = '';
      b.append(`有新版本 v${r.latest}`, Object.assign(document.createElement('small'), { textContent: r.asset_name ? '點這裡下載' : '點這裡前往下載頁' }));
      b.onclick = () => tx.open_url(r.asset_url || r.url);
      b.classList.remove('hidden');
    } else b.classList.add('hidden');
    return r;
  }

  let panelCleanup = null;
  function closePanel() {
    $('modalBack').classList.add('hidden');
    document.removeEventListener('keydown', panelKey, true);
    if (panelCleanup) { panelCleanup(); panelCleanup = null; }
  }
  function panelKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(); } }

  async function showAbout() {
    let a;
    try { a = await tx.about_info(); } catch (e) { a = null; }
    if (!a) { toast('讀不到程式資訊'); return; }
    const modal = $('modal'), back = $('modalBack');
    modal.innerHTML = '';
    modal.setAttribute('aria-modal', 'true');
    const h = Object.assign(document.createElement('h2'), { textContent: '關於 AutoSubtitle 字幕工房' });
    const grid = Object.assign(document.createElement('div'), { className: 'about-grid' });
    const row = (k, v, btnLabel, fn, wrap) => {
      grid.append(Object.assign(document.createElement('span'), { className: 'k', textContent: k }));
      const vv = Object.assign(document.createElement('span'), { className: 'v' + (wrap ? ' wrap' : ''), textContent: v, title: v });
      grid.append(vv);
      if (btnLabel) {
        const b = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: btnLabel });
        b.onclick = fn; grid.append(b);
      } else grid.append(document.createElement('span'));
      return vv;
    };
    const sep = () => grid.append(Object.assign(document.createElement('div'), { className: 'about-sep' }));
    row('版本', `${a.dev ? '開發版 ' : 'v'}${a.version}（${a.flavor}${a.frozen ? '' : '，原始碼執行'}）`);
    row('系統', `${a.platform} · Python ${a.python}`);
    row('運算', st.compute ? (st.compute.gpu_ok ? st.compute.gpu_label : st.compute.cpu_label) : '—');
    sep();
    row('逐字稿', a.output_dir, '開啟', () => tx.open_folder(st.outdir || a.output_dir));
    row('模型', a.models_dir, '開啟', () => tx.open_models_folder());
    row('資料', a.data_dir, '開啟', () => tx.open_folder(a.data_dir));
    row('紀錄檔', a.log_dir, '開啟', () => tx.open_logs_folder());
    sep();
    const upd = row('更新', a.dev ? '開發版不比對版本' : '尚未檢查', '檢查更新', async e => {
      const btn = e.target; btn.disabled = true; upd.textContent = '檢查中…';
      const r = await checkUpdate(true);
      btn.disabled = false;
      if (!r) upd.textContent = '檢查失敗';
      else if (r.error) upd.textContent = r.error;
      else if (r.newer) upd.textContent = `有新版本 v${r.latest}，點側欄的提示下載`;
      else upd.textContent = r.latest ? `已是最新（最新版 v${r.latest}）` : '已是最新';
    }, true);
    grid.append(document.createElement('span'));
    const chk = Object.assign(document.createElement('label'), { className: 'about-check' });
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!(a.settings && a.settings.check_updates) });
    cb.onchange = async () => { const r = await tx.set_setting('check_updates', cb.checked); if (r && r.error) toast(r.error); };
    chk.append(cb, '啟動時自動檢查（每天最多一次，只連線到 GitHub）');
    grid.append(chk, document.createElement('span'));
    sep();
    row('授權', 'MIT License · 使用的開源元件與授權', '查看', () => tx.open_notices());
    row('回報問題', '複製版本與最近的紀錄，貼到 GitHub', '複製並前往', async () => {
      const text = await tx.diagnostics();
      const ok = await copyText(text);
      toast(ok ? '已複製診斷資訊，請貼到回報內容裡' : '複製失敗，請到「紀錄檔」資料夾附上 autosubtitle.log');
      tx.open_url('https://github.com/alextixu/AutoSubtitle/issues/new');
    });
    const actions = Object.assign(document.createElement('div'), { className: 'actions' });
    const close = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: '關閉' });
    close.onclick = closePanel;
    actions.append(close);
    modal.append(h, grid, actions);
    back.classList.remove('hidden');
    document.addEventListener('keydown', panelKey, true);
    close.focus();
  }

  // ---------- 拖放檔案 ----------
  // 完整路徑只有 pywebview 在 Python 端拿得到（gui.py on_drop → window.__asDrop）；這裡只處理畫面與路由
  window.__asDrop = async paths => {
    const list = Array.isArray(paths) ? paths : [paths];
    if (!list.length || !list[0]) return;
    const view = VIEWS.find(v => !$('view-' + v).classList.contains('hidden'));
    if (view === 'editor' && window.__asEditorDrop) { window.__asEditorDrop(list[0]); return; }
    if (view !== 'transcribe') showView('transcribe');
    if (st.running) { toast('轉檔進行中，完成後再加入檔案'); return; }
    addFiles(await tx.tx_expand(list));
  };
  (function bindDrop() {
    let depth = 0;
    const over = $('dropOverlay');
    const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; over.classList.remove('hidden'); });
    document.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) over.classList.add('hidden'); });
    document.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; over.classList.add('hidden');
      if (!(window.pywebview && window.pywebview.api)) toast('瀏覽器預覽模式拿不到檔案路徑，請用桌面程式');
      // 桌面程式：路徑由後端的 DOM drop 事件送到 window.__asDrop
    });
  })();

  // ---------- 第一次使用 ----------
  function showOnboarding() {
    const modal = $('modal'), back = $('modalBack');
    modal.innerHTML = '';
    const h = Object.assign(document.createElement('h2'), { textContent: '歡迎使用字幕工房' });
    const steps = [
      ['🔒', '完全在你的電腦上辨識', '影片不會上傳到任何雲端，也不需要登入。只有第一次下載模型時需要網路。'],
      ['📦', '第一次會先下載模型', '預設的「標準」模型約 486 MB，下載時會顯示進度，之後就能離線使用。側欄「模型」頁可以先下載或刪除。'],
      ['✂️', '兩種用法', '「逐字稿轉檔」：選檔就轉，產出文字與 SRT。「字幕編輯器」：逐句修改、調時間、上樣式、匯出成品影片。'],
    ];
    const list = Object.assign(document.createElement('div'), { className: 'onboard' });
    for (const [icon, t, d] of steps) {
      const row = document.createElement('div');
      row.className = 'onboard-row';
      row.append(Object.assign(document.createElement('span'), { className: 'onboard-icon', textContent: icon }));
      const txt = document.createElement('div');
      txt.append(Object.assign(document.createElement('b'), { textContent: t }), Object.assign(document.createElement('p'), { textContent: d }));
      row.append(txt);
      list.append(row);
    }
    const actions = Object.assign(document.createElement('div'), { className: 'actions' });
    const ok = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: '開始使用' });
    ok.onclick = () => { back.classList.add('hidden'); tx.set_setting && tx.set_setting('onboarded', true); };
    actions.append(ok);
    modal.append(h, list, actions);
    back.classList.remove('hidden');
    ok.focus();
  }

  // ---------- 逐字稿轉檔 ----------
  const basename = p => (p || '').split(/[\\/]/).pop();

  const STATE_TEXT = { pending: '等待中', running: '辨識中', done: '完成', error: '失敗', cancelled: '已取消' };
  // 加入檔案（已在清單的略過）；轉檔結束後再加檔，就開始一份新的佇列
  function addFiles(list, replace) {
    list = (list || []).filter(Boolean);
    if (!list.length) { toast('沒有找到可以轉檔的影音檔'); return; }
    if (st.queue && !st.running) { st.files = []; st.queue = null; }
    const merged = replace ? [] : [...st.files];
    let added = 0;
    for (const p of list) if (!merged.some(x => x.toLowerCase() === p.toLowerCase())) { merged.push(p); added++; }
    if (merged.length > 200) toast('一次最多 200 個檔案，多的已略過');
    st.files = merged.slice(0, 200);
    renderFiles();
    if (list.length > 1 || st.files.length > 1) toast(added ? `已加入 ${added} 個檔案，共 ${st.files.length} 個` : '這些檔案已經在清單裡了');
    else toast('已選好：' + basename(list[0]));
  }
  function removeFile(i) { st.files.splice(i, 1); st.queue = null; renderFiles(); }
  function renderFiles() {
    const n = st.files.length, many = n > 1;
    $('txFileName').textContent = n === 0 ? '還沒選擇檔案' : many ? `${n} 個檔案` : basename(st.files[0]);
    $('txFilePath').textContent = n === 0 ? '支援 mp4、mov、mkv、webm、mp3、wav、m4a、flac；可以多選或拖入資料夾'
      : many ? '依序辨識，每個檔案各自輸出三種檔案' : st.files[0];
    for (const id of ['txStart', 'txEnd']) $(id).disabled = st.running || many;
    $('txRangeRow').classList.toggle('dim', many);
    $('txRangeHint').textContent = many ? '多個檔案時一律轉整支' : '留空＝整支；格式如 13:00、1:02:03、780';
    $('txStartBtn').textContent = many ? `開始轉檔（${n} 個）` : '開始轉檔';
    const box = $('txQueue');
    box.classList.toggle('hidden', !many);
    box.innerHTML = '';
    if (!many) { if (!st.running) setStatus(n ? '按「開始轉檔」' : '選一個影音檔開始'); return; }
    st.files.forEach((p, i) => {
      const q = st.queue && st.queue[i];
      const state = q ? q.state : 'pending';
      const row = Object.assign(document.createElement('div'), { className: `q-row ${state}${st.view === i ? ' viewing' : ''}` });
      row.setAttribute('role', 'listitem');
      const main = Object.assign(document.createElement('button'), { type: 'button', className: 'q-main', disabled: state !== 'done' });
      main.title = state === 'done' ? '查看這個檔案的逐字稿' : p;
      main.append(Object.assign(document.createElement('b'), { textContent: basename(p) }),
                  Object.assign(document.createElement('span'), { className: 'muted', textContent: q && (q.summary || q.error) || p }));
      main.onclick = () => showItem(i);
      let label = STATE_TEXT[state];
      if (state === 'running' && st.running) label = st.curPct != null ? `辨識中 ${st.curPct}%` : '準備中';
      const badge = Object.assign(document.createElement('span'), { className: 'q-badge ' + state, textContent: label });
      if (q && q.error) badge.title = q.error;
      row.append(main, badge);
      if (!st.running) {
        const del = Object.assign(document.createElement('button'), { type: 'button', className: 'q-del', textContent: '×', title: '從清單移除' });
        del.setAttribute('aria-label', `移除 ${basename(p)}`);
        del.onclick = () => removeFile(i);
        row.append(del);
      }
      box.append(row);
    });
    if (!st.running && !st.queue) setStatus(`按「開始轉檔」，${n} 個檔案會依序辨識`);
  }
  async function showItem(i) {
    const res = await tx.tx_result(i);
    if (!res) return;
    st.view = i;
    renderResult(res);
    renderFiles();
    $('txResult').classList.remove('hidden');
    showTab('text');
  }
  function setGlossary(p) {
    st.glossary = p || null;
    const el = $('txGlossary');
    el.textContent = p ? ltr(p) : '選填：純文字檔，一行一個專有名詞，辨識時優先採用';
    el.title = p || '';
    el.classList.toggle('muted', !p);
    $('txClearGlossary').classList.toggle('hidden', !p);
  }
  const ltr = p => (p ? `\u200E${p}\u200E` : '');   // rtl 截斷時保持路徑原本的順序
  function setOutdir(p) { st.outdir = p || ''; $('txOutdir').textContent = ltr(p); $('txOutdir').title = p || ''; }
  function setStatus(text, kind) {
    $('txStatus').textContent = (st.head || '') + text;
    const line = $('txStatus').parentElement;
    line.classList.toggle('err', kind === 'err');
    line.classList.toggle('ok', kind === 'ok');
  }
  function setRunning(on) {
    st.running = on;
    $('txStartBtn').classList.toggle('hidden', on);
    $('txCancelBtn').classList.toggle('hidden', !on);
    $('txCancelBtn').disabled = false;
    for (const id of ['txPick', 'txPickFolder', 'txPickGlossary', 'txPickOutdir', 'txClearGlossary'])
      $(id).disabled = on;
    // 轉檔中鎖住本頁的辨識設定（顯示的就是正在跑的設定）；編輯器那份彈窗不受影響
    $('txRecog').querySelectorAll('button, select, input').forEach(b => { b.disabled = on; });
    renderFiles();
  }
  function showTab(t) {
    $('txTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    $('txText').classList.toggle('hidden', t !== 'text');
    $('txLog').classList.toggle('hidden', t !== 'log');
  }
  function fmtElapsed(s) {
    s = Math.round(s || 0);
    return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
  }

  async function start() {
    if (st.running) return;
    if (!st.files.length) { toast('請先選一個影音檔'); $('txPick').focus(); return; }
    if (st.queue) { st.queue = null; }      // 再按一次開始＝把同一份清單重跑
    if (plannedDevice().device === null) { toast('這台電腦目前無法使用 GPU：' + (st.compute ? st.compute.reason : '')); return; }
    const mm = modelById(recog.v.model);
    if (mm && !mm.downloaded && !mm.downloading) {
      const ok = await confirmDialog({
        title: `第一次使用「${mm.label}」模型`,
        text: `需要先從 huggingface.co 下載 ${fmtBytes(mm.bytes)}，下載完成後會自動開始轉檔。之後再用就不必下載，完全離線。`,
        ok: '下載並開始',
      });
      if (!ok) return;
    }
    st.dlSeen = false;
    const params = {
      files: st.files, start: $('txStart').value, end: $('txEnd').value, ...recog.v,
      glossary: st.glossary, outdir: st.outdir,
    };
    const r = await tx.tx_start(params);
    if (!r || r.error) { toast(r ? r.error : '無法開始'); return; }
    st.result = null; st.text = ''; st.view = null; st.curPct = null;
    st.queue = st.files.map(() => ({ state: 'pending' }));
    $('txResult').classList.remove('hidden');
    $('txFiles').classList.add('hidden'); $('txFiles').innerHTML = '';
    $('txText').innerHTML = ''; $('txLog').textContent = '';
    $('txCopy').disabled = true;
    $('txToEditor').disabled = true;
    showTab('log');
    $('txFill').style.width = '0%';
    $('txProgress').classList.add('indeterminate');
    setRunning(true);
    showUsedDevice(null);
    setSide(plannedDevice().device === 'cuda' ? 'gpu busy' : 'cpu busy', '準備中', shortDev(plannedDevice().label));
    setStatus('準備中…');
    poll();
  }

  async function poll() {
    let j;
    try { j = await tx.tx_poll(); } catch (e) { setTimeout(poll, 500); return; }
    if (!j) { setTimeout(poll, 300); return; }
    const logEl = $('txLog');
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
    const text = (j.logs || []).join('\n');
    if (logEl.textContent !== text) { logEl.textContent = text; if (atBottom) logEl.scrollTop = logEl.scrollHeight; }
    $('txElapsed').textContent = j.state === 'idle' ? '' : fmtElapsed(j.elapsed);
    if (j.device) showUsedDevice(j.device);
    const many = (j.queue || []).length > 1;
    const head = many ? `[${(j.index || 0) + 1}/${j.queue.length}] ` : '';
    if (j.queue && j.queue.length) {
      const pct = j.stage === 'transcribe' ? Math.round(j.progress * 100) : null;
      const key = JSON.stringify([j.queue.map(q => q.state + (q.summary || q.error || '')), pct]);
      if (key !== st.qKey) { st.qKey = key; st.queue = j.queue; st.curPct = pct; if (many) renderFiles(); }
    }

    if (j.state === 'running' || j.state === 'cancelling') {
      const bar = (frac) => {
        if (frac == null) { $('txProgress').classList.add('indeterminate'); return; }
        $('txProgress').classList.remove('indeterminate');
        $('txFill').style.width = `${(frac * 100).toFixed(1)}%`;
      };
      const eta = fmtEta(j.eta);
      st.head = head;                                  // 多檔時狀態列前面標上第幾個
      if (j.state === 'cancelling') { bar(null); st.head = ''; setStatus(j.status || '取消中…'); }
      else if (j.stage === 'download' && j.download) {
        const d = j.download, m = modelById(d.model);
        bar(d.done ? d.done / d.total : null);
        setStatus(d.done ? `下載模型「${m ? m.label : d.model}」 ${fmtBytes(d.done)} / ${fmtBytes(d.total)}` +
                           `${d.speed ? ` · ${(d.speed / 1e6).toFixed(1)} MB/s` : ''}${eta ? ` · ${eta}` : ''}`
                         : `連線到 huggingface.co，準備下載「${m ? m.label : d.model}」（${fmtBytes(d.total)}）…`);
      } else if (j.stage === 'decode') {
        bar(j.stage_frac || 0);
        setStatus(`讀取音訊 ${Math.round((j.stage_frac || 0) * 100)}%`);
      } else if (j.stage === 'transcribe') {
        bar(j.progress);
        setStatus(`辨識中 ${Math.round(j.progress * 100)}%${eta ? ` · ${eta}` : ''}`);
      } else { bar(null); setStatus(j.status || '準備中…'); }
      if (j.stage === 'download' && !st.dlSeen) { st.dlSeen = true; refreshModels(); }
      setTimeout(poll, 250);
      return;
    }
    $('txProgress').classList.remove('indeterminate');
    setRunning(false);
    renderDevice();
    refreshModels();
    st.head = '';
    st.queue = j.queue || st.queue;
    renderFiles();
    if (j.state === 'done') {
      $('txFill').style.width = '100%';
      const first = many ? (j.queue || []).findIndex(q => q.state === 'done') : null;
      const res = await tx.tx_result(first);
      st.view = many ? first : null;
      renderResult(res);
      renderFiles();
      setStatus(many ? j.summary : (res && res.summary ? res.summary : '完成'), 'ok');
      showTab(many && (j.queue || []).some(q => q.state === 'error') ? 'log' : 'text');
      if (many) toast(j.summary + '。點清單裡的檔案可以查看各自的逐字稿');
    } else if (j.state === 'cancelled') {
      $('txFill').style.width = '0%';
      setStatus(j.status || '已取消');
      toast('已取消轉檔');
    } else if (j.state === 'error') {
      $('txFill').style.width = '0%';
      setStatus('失敗：' + (j.error || '未知錯誤'), 'err');
      toast('轉檔失敗，詳見「紀錄」');
    }
  }

  function renderResult(res) {
    st.result = res || null;
    $('txResultName').textContent = res && res.name && st.files.length > 1 ? res.name : '';
    st.text = res ? res.text || '' : '';
    const files = $('txFiles');
    files.innerHTML = '';
    for (const f of (res && res.files) || []) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = f;
      chip.append(Object.assign(document.createElement('b'), { textContent: basename(f) }));
      files.append(chip);
    }
    files.classList.toggle('hidden', !files.children.length);
    const box = $('txText');
    box.innerHTML = '';
    const cues = (res && res.cues) || [];
    if (!cues.length) {
      box.append(Object.assign(document.createElement('div'), { className: 'tx-empty', textContent: '（沒有辨識到語音）' }));
    }
    for (const c of cues) {
      const row = document.createElement('div');
      row.className = 'tx-row';
      row.append(Object.assign(document.createElement('span'), { className: 't', textContent: c.clock }),
                 Object.assign(document.createElement('span'), { className: 's', textContent: c.text }));
      box.append(row);
    }
    $('txCopy').disabled = !st.text;
    $('txToEditor').disabled = !(res && res.cues && res.cues.length);
  }

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* 走後備 */ }
    try { const r = await tx.copy_text(t); if (r && r.ok) return true; } catch (e) { /* 走後備 */ }
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function bindTranscribe(info) {
    setOutdir(info.outdir || '');
    mountRecog($('txRecog'), 'tx');
    renderFiles(); setGlossary(null);

    $('txPick').onclick = async () => { const p = await tx.tx_pick_media(); if (p) addFiles(Array.isArray(p) ? p : [p]); };
    $('txPickFolder').onclick = async () => { const p = await tx.tx_pick_folder(); if (p) addFiles(p); };
    $('txPickGlossary').onclick = async () => { const p = await tx.tx_pick_glossary(); if (p) setGlossary(p); };
    $('txClearGlossary').onclick = () => setGlossary(null);
    $('txPickOutdir').onclick = async () => { const p = await tx.tx_pick_outdir(); if (p) setOutdir(p); };
    $('txTabs').onclick = e => { const b = e.target.closest('button[data-t]'); if (b) showTab(b.dataset.t); };
    $('txStartBtn').onclick = start;
    $('txCancelBtn').onclick = async () => { $('txCancelBtn').disabled = true; setStatus('取消中…'); await tx.tx_cancel(); };
    $('txCopy').onclick = async () => {
      if (!st.text) return;
      toast((await copyText(st.text)) ? '已複製全文到剪貼簿' : '複製失敗，請直接選取文字複製');
    };
    $('txOpenOut').onclick = () => tx.open_folder((st.result && st.result.outdir) || st.outdir);
    $('txToEditor').onclick = async () => {
      if (!tx.tx_to_project) { toast('瀏覽器預覽模式不支援'); return; }
      const r = await tx.tx_to_project(st.view);
      if (!r || r.error) { toast((r && r.error) || '無法建立專案'); return; }
      showView('editor');
      if (window.__asOpenProject) await window.__asOpenProject(r.name);
      toast(`已建立專案「${r.name}」，可以逐句修改了`);
    };
    for (const id of ['txStart', 'txEnd']) $(id).onkeydown = e => { if (e.key === 'Enter') start(); };
  }

  // ---------- 初始化 ----------
  (async function init() {
    for (let i = 0; i < 100 && !api; i++) await sleep(50);   // 等 app.js 選好 api
    tx = (api && typeof api.tx_start === 'function') ? api : txMock;
    let info = {};
    try { info = (await tx.get_info()) || {}; } catch (e) { info = {}; }
    if (info.settings && info.settings.recog) Object.assign(recog.v, info.settings.recog);
    bindTranscribe(info);
    bindModels();
    refreshModels();
    $('aboutBtn').onclick = showAbout;
    if (tx !== txMock && info.settings && info.settings.onboarded === false) setTimeout(showOnboarding, 600);
    setTimeout(() => checkUpdate(false), 3000);   // 每天最多一次，可在「關於」關閉
    $('appVersion').textContent = info.version && info.version !== '0.0.0-dev' ? `v${info.version}` : (info.version ? '開發版' : '');
    st.compute = info.compute || null;
    syncRecog();

    document.querySelectorAll('.nav-item[data-view]').forEach(b => { b.onclick = () => showView(b.dataset.view); });
    $('navOutput').onclick = () => tx.open_folder(st.outdir || '');

    let v = info.initial_view;
    if (!v) { try { v = localStorage.getItem('as.view'); } catch (e) { v = null; } }
    showView(v || 'transcribe');

    // 轉檔中關閉前提醒（pywebview 端也會再確認一次）
    window.addEventListener('beforeunload', e => { if (st.running) { e.preventDefault(); e.returnValue = ''; } });
  })();
})();
