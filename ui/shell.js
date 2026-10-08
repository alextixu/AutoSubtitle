/* 字幕工房 — 單一視窗外殼：側欄切換 + 逐字稿轉檔
 * 載入順序在 app.js 之後，共用它的 api / $ / toast / video。
 * 後端：gui.py 的 tx_* 方法；瀏覽器直開（沒有 pywebview）時用 mock 模擬進度，方便看版面。 */
'use strict';

(function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const VIEWS = ['transcribe', 'editor'];
  let tx = null;                 // 有 tx_* 方法的 api（pywebview 或 mock）
  const st = { file: null, glossary: null, outdir: '', model: 'small', running: false, text: '', result: null, compute: null };

  // ---------- 瀏覽器直開時的 mock：只為了看版面 ----------
  const txMock = (() => {
    let job = null, t0 = 0;
    const lines = ['大家好，今天要介紹的是本機離線語音辨識。', '影片不會上傳到任何雲端，也不需要登入。',
                   '選好檔案以後按開始轉檔，就會產出三種檔案。', '長影片可以只轉其中一段，省下等待時間。'];
    return {
      get_info: async () => ({ app: 'AutoSubtitle 字幕工房（mock）', initial_view: 'transcribe', outdir: 'E:\\AutoSubtitle\\output', models: ['tiny', 'base', 'small', 'medium', 'large-v3'], ffmpeg: false,
        compute: { cuda_devices: 1, cuda_libs: true, gpu_ok: true, gpu_name: 'NVIDIA GeForce RTX 3080 Ti', reason: '', auto: 'cuda', cpu_label: 'CPU · 4 執行緒', gpu_label: 'GPU · NVIDIA GeForce RTX 3080 Ti', auto_label: 'GPU · NVIDIA GeForce RTX 3080 Ti', hint: 'pip install nvidia-cublas-cu12 nvidia-cudnn-cu12' } }),
      open_folder: async () => (toast('mock 模式無法開資料夾'), { ok: true }),
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
    setSide(plannedDevice().device === 'cuda' ? 'gpu busy' : 'cpu busy', '載入模型中', shortDev(plannedDevice().label));
    setStatus('載入模型中…');
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
      if (j.progress > 0) {
        $('txProgress').classList.remove('indeterminate');
        $('txFill').style.width = `${Math.round(j.progress * 100)}%`;
        setStatus(j.state === 'cancelling' ? j.status : `辨識中 ${Math.round(j.progress * 100)}%`);
      } else setStatus(j.status || '載入模型中…');
      setTimeout(poll, 250);
      return;
    }
    $('txProgress').classList.remove('indeterminate');
    setRunning(false);
    renderDevice();
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
    };
    $('txModel').querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', x.classList.contains('on')));
    $('txTabs').onclick = e => { const b = e.target.closest('button[data-t]'); if (b) showTab(b.dataset.t); };
    $('txStartBtn').onclick = start;
    $('txCancelBtn').onclick = async () => { $('txCancelBtn').disabled = true; setStatus('取消中…（等目前這句辨識完）'); await tx.tx_cancel(); };
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
