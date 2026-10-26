/* 字幕工房 — 單一視窗外殼：側欄切換 + 逐字稿轉檔
 * 載入順序在 app.js 之後，共用它的 api / $ / toast / video。
 * 後端：gui.py 的 tx_* 方法；瀏覽器直開（沒有 pywebview）時用 mock 模擬進度，方便看版面。 */
'use strict';

(function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const VIEWS = ['transcribe', 'models', 'editor'];
  let tx = null;                 // 有 tx_* 方法的 api（pywebview 或 mock）
  const st = { file: null, glossary: null, outdir: '', model: 'small', running: false, text: '', result: null, compute: null };

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
      copy_text: async () => ({ ok: false }),
      tx_pick_media: async () => 'E:\\影片\\會議錄影 2026-10-07.mp4',
      tx_pick_glossary: async () => 'E:\\影片\\詞庫.txt',
      tx_pick_outdir: async () => 'E:\\影片\\輸出',
      tx_busy: async () => !!job && job.state === 'running',
      tx_start: async p => { job = { state: 'running', progress: 0, status: '載入模型中…', device: null, logs: [`辨識 ${p.src.split(/[\\/]/).pop()}（模型 ${p.model}）`, '第一次用某個模型會先下載模型檔，之後離線可用。'] }; t0 = Date.now(); return { ok: true }; },
      tx_cancel: async () => { if (job) { job.state = 'cancelled'; job.status = '已取消'; job.logs.push('已取消。'); } return { ok: true }; },
      tx_poll: async () => {
        if (!job) return { state: 'idle', progress: 0, status: '', logs: [], elapsed: 0 };
        const el = (Date.now() - t0) / 1000;
        if (job.state === 'running') {
          if (el > 1) job.device = { device_used: 'cuda', device_label: 'GPU · NVIDIA GeForce RTX 3080 Ti', compute_type: 'int8_float16', model: 'small' };
          job.progress = Math.min(1, Math.max(0, (el - 1.2) / 4));
          if (job.progress >= 1) { job.state = 'done'; job.status = `完成：${lines.length} 句，語言 zh，耗時 ${el.toFixed(0)} 秒`; job.logs.push(job.status); }
        }
        return { ...job, elapsed: +el.toFixed(1), summary: job.state === 'done' ? job.status : null };
      },
      tx_result: async () => ({
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
  }

  // ---------- 運算裝置顯示 ----------
  const shortDev = label => (label || '').replace(/NVIDIA\s+(GeForce\s+)?/i, '');

  // 依目前選擇算出「會用什麼」：{device:'cuda'|'cpu'|null, label, warn}
  function plannedDevice() {
    const c = st.compute, sel = $('txDevice').value;
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
    const p = plannedDevice(), note = $('txDeviceNote');
    if (!st.compute) { note.textContent = ''; return; }
    if (p.device === 'cuda') {
      note.textContent = `將使用 ${shortDev(p.label)}`; note.className = 'device-note ok';
    } else if (p.device === 'cpu') {
      note.textContent = p.warn ? '將使用 CPU（GPU 缺少 CUDA 函式庫）' : `將使用 ${p.label}`;
      note.className = 'device-note' + (p.warn ? ' warn' : '');
    } else {
      note.textContent = '無法使用 GPU，請改選 CPU 或自動'; note.className = 'device-note warn';
    }
    note.title = p.warn || '';
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
    const m = modelById(st.model);
    $('txModel').querySelectorAll('button[data-v]').forEach(b => {
      const x = modelById(b.dataset.v);
      b.classList.toggle('dl', !!(x && x.downloaded));
      if (x) b.title = `${x.label}：${x.desc}（${fmtBytes(x.bytes)}${x.downloaded ? '，已下載' : '，需下載'}）`;
    });
    if (!m) { $('txModelHint').textContent = '越大越準也越慢'; return; }
    $('txModelHint').textContent = m.downloaded ? `${m.label} · ${m.desc} · 已下載`
      : m.downloading ? `${m.label} · 下載中 ${Math.round(m.downloading.done / m.bytes * 100)}%`
      : `${m.label} · ${m.desc} · 第一次使用需下載 ${fmtBytes(m.bytes)}`;
  }

  function bindModels() {
    $('mdOpen').onclick = () => tx.open_models_folder();
    $('txModelsLink').onclick = () => showView('models');
  }

  // ---------- 逐字稿轉檔 ----------
  const basename = p => (p || '').split(/[\\/]/).pop();

  function setFile(p) {
    st.file = p || null;
    $('txFileName').textContent = p ? basename(p) : '還沒選擇檔案';
    $('txFilePath').textContent = p ? p : '支援 mp4、mov、mkv、webm、mp3、wav、m4a、flac';
    if (!st.running) setStatus(p ? '按「開始轉檔」' : '選一個影音檔開始');
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
    $('txStatus').textContent = text;
    const line = $('txStatus').parentElement;
    line.classList.toggle('err', kind === 'err');
    line.classList.toggle('ok', kind === 'ok');
  }
  function setRunning(on) {
    st.running = on;
    $('txStartBtn').classList.toggle('hidden', on);
    $('txCancelBtn').classList.toggle('hidden', !on);
    $('txCancelBtn').disabled = false;
    for (const id of ['txPick', 'txPickGlossary', 'txPickOutdir', 'txClearGlossary', 'txStart', 'txEnd', 'txLang', 'txDevice', 'txTw'])
      $(id).disabled = on;
    $('txModel').querySelectorAll('button').forEach(b => { b.disabled = on; });
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
    if (!st.file) { toast('請先選一個影音檔'); $('txPick').focus(); return; }
    if (plannedDevice().device === null) { toast('這台電腦目前無法使用 GPU：' + (st.compute ? st.compute.reason : '')); return; }
    const mm = modelById(st.model);
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
      src: st.file, start: $('txStart').value, end: $('txEnd').value, model: st.model,
      lang: $('txLang').value, device: $('txDevice').value, to_tw: $('txTw').checked,
      glossary: st.glossary, outdir: st.outdir,
    };
    const r = await tx.tx_start(params);
    if (!r || r.error) { toast(r ? r.error : '無法開始'); return; }
    st.result = null; st.text = '';
    $('txResult').classList.remove('hidden');
    $('txFiles').classList.add('hidden'); $('txFiles').innerHTML = '';
    $('txText').innerHTML = ''; $('txLog').textContent = '';
    $('txCopy').disabled = true;
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

    if (j.state === 'running' || j.state === 'cancelling') {
      const bar = (frac) => {
        if (frac == null) { $('txProgress').classList.add('indeterminate'); return; }
        $('txProgress').classList.remove('indeterminate');
        $('txFill').style.width = `${(frac * 100).toFixed(1)}%`;
      };
      const eta = fmtEta(j.eta);
      if (j.state === 'cancelling') { bar(null); setStatus(j.status || '取消中…'); }
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
    if (j.state === 'done') {
      $('txFill').style.width = '100%';
      const res = await tx.tx_result();
      renderResult(res);
      setStatus(res && res.summary ? res.summary : '完成', 'ok');
      showTab('text');
    } else if (j.state === 'cancelled') {
      $('txFill').style.width = '0%';
      setStatus('已取消');
      toast('已取消轉檔');
    } else if (j.state === 'error') {
      $('txFill').style.width = '0%';
      setStatus('失敗：' + (j.error || '未知錯誤'), 'err');
      toast('轉檔失敗，詳見「紀錄」');
    }
  }

  function renderResult(res) {
    st.result = res || null;
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
    setFile(null); setGlossary(null);

    $('txPick').onclick = async () => { const p = await tx.tx_pick_media(); if (p) setFile(p); };
    $('txPickGlossary').onclick = async () => { const p = await tx.tx_pick_glossary(); if (p) setGlossary(p); };
    $('txClearGlossary').onclick = () => setGlossary(null);
    $('txPickOutdir').onclick = async () => { const p = await tx.tx_pick_outdir(); if (p) setOutdir(p); };
    $('txModel').onclick = e => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.disabled) return;
      st.model = b.dataset.v;
      $('txModel').querySelectorAll('button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      renderModelHint();
    };
    $('txModel').querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', x.classList.contains('on')));
    $('txTabs').onclick = e => { const b = e.target.closest('button[data-t]'); if (b) showTab(b.dataset.t); };
    $('txStartBtn').onclick = start;
    $('txCancelBtn').onclick = async () => { $('txCancelBtn').disabled = true; setStatus('取消中…'); await tx.tx_cancel(); };
    $('txCopy').onclick = async () => {
      if (!st.text) return;
      toast((await copyText(st.text)) ? '已複製全文到剪貼簿' : '複製失敗，請直接選取文字複製');
    };
    $('txOpenOut').onclick = () => tx.open_folder((st.result && st.result.outdir) || st.outdir);
    for (const id of ['txStart', 'txEnd']) $(id).onkeydown = e => { if (e.key === 'Enter') start(); };
  }

  // ---------- 初始化 ----------
  (async function init() {
    for (let i = 0; i < 100 && !api; i++) await sleep(50);   // 等 app.js 選好 api
    tx = (api && typeof api.tx_start === 'function') ? api : txMock;
    let info = {};
    try { info = (await tx.get_info()) || {}; } catch (e) { info = {}; }
    bindTranscribe(info);
    bindModels();
    refreshModels();
    $('appVersion').textContent = info.version && info.version !== '0.0.0-dev' ? `v${info.version}` : (info.version ? '開發版' : '');
    st.compute = info.compute || null;
    $('txDevice').addEventListener('change', renderDevice);
    renderDevice();

    document.querySelectorAll('.nav-item[data-view]').forEach(b => { b.onclick = () => showView(b.dataset.view); });
    $('navOutput').onclick = () => tx.open_folder(st.outdir || '');

    let v = info.initial_view;
    if (!v) { try { v = localStorage.getItem('as.view'); } catch (e) { v = null; } }
    showView(v || 'transcribe');

    // 轉檔中關閉前提醒（pywebview 端也會再確認一次）
    window.addEventListener('beforeunload', e => { if (st.running) { e.preventDefault(); e.returnValue = ''; } });
  })();
})();
