#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gui.py — AutoSubtitle 字幕工房：單一視窗桌面程式（pywebview + WebView2）

  python gui.py              開主視窗，左側切換「逐字稿轉檔」／「字幕編輯器」
  python gui.py transcribe   開啟後直接停在逐字稿轉檔
  python gui.py editor       開啟後直接停在字幕編輯器

所有功能都在同一個視窗裡切換，不另開視窗。
逐字稿轉檔＝transcribe.py 的視窗版：選檔、選模型、可只轉其中一段，
產出 純文字／含時間／SRT 三個檔，檔名規則與指令版相同。
字幕編輯器的後端 API 在 app.py，本檔只加上逐字稿轉檔的 API（tx_*）。
"""
from __future__ import annotations
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

APP_DIR = Path(__file__).parent
sys.path.insert(0, str(APP_DIR))

from app import Api as EditorApi                                            # noqa: E402
from engine import appinfo, exporter, models, transcriber                  # noqa: E402
from engine.paths import DATA_DIR, FROZEN, OUTPUT_DIR, ui_file             # noqa: E402
from engine._version import __version__                                  # noqa: E402
from transcribe import fmt_clock, output_stem, parse_time, write_outputs   # noqa: E402

APP_NAME = 'AutoSubtitle'
APP_TITLE = 'AutoSubtitle 字幕工房'
DEFAULT_OUTDIR = OUTPUT_DIR
MEDIA_EXTS = ('.mp4', '.mov', '.mkv', '.webm', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.flac')
MEDIA_FILTER = '影音檔 (' + ';'.join('*' + e for e in MEDIA_EXTS) + ')'
MAX_QUEUE = 200  # 一次最多排幾個檔案
ALL_FILTER = '所有檔案 (*.*)'
MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3']
LOG_KEEP = 300  # 紀錄最多保留的行數


class Cancelled(Exception):
    """使用者按了取消；從 progress callback 拋出以中斷辨識迴圈"""


class _JobWriter:
    """把辨識引擎 print 的訊息（模型降級、下載進度）收進工作狀態。
    stdout 的每一行進「紀錄」；stderr（tqdm 下載進度等）只更新狀態列。"""

    encoding = 'utf-8'

    def __init__(self, job: 'TranscribeJob', kind: str):
        self.job, self.kind = job, kind

    def write(self, s: str):
        for line in s.replace('\r', '\n').split('\n'):
            if line.strip():
                if self.kind == 'log':
                    self.job.log(line.strip())
                else:
                    self.job.status(line.strip()[-90:])
        return len(s)

    def flush(self):
        pass

    def isatty(self):
        return False


class TranscribeJob:
    """逐字稿轉檔工作佇列：背景執行緒依序辨識一個或多個檔案，前端用 tx_poll 輪詢。
    頂層的 progress／stage／device 描述「目前這一個檔案」，queue 列出每個檔案的狀態。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.thread: threading.Thread | None = None
        self.reset()

    def reset(self):
        self.state = 'idle'        # idle / running / cancelling / done / cancelled / error
        self.logs: list[str] = []
        self.error: str | None = None
        self.result: dict | None = None   # 最近一個完成的檔案
        self.summary: str | None = None
        self.t0 = 0.0
        self.elapsed = 0.0
        self.queue: list[dict] = []
        self.index = 0
        self._reset_item()

    def _reset_item(self):
        self.progress = 0.0
        self.status_text = ''
        self.device: dict | None = None   # 實際使用的運算裝置（模型載入後才知道）
        self.stage = ''                   # wait / download / decode / load / transcribe
        self.stage_frac: float | None = None
        self.download: dict | None = None # {model, done, total, speed}
        self.recog_t0 = 0.0

    @property
    def busy(self) -> bool:
        return self.state in ('running', 'cancelling')

    def log(self, line: str):
        with self.lock:
            self.logs.append(line)
            del self.logs[:-LOG_KEEP]

    def status(self, text: str):
        with self.lock:
            self.status_text = text

    def item(self, i: int | None = None) -> dict | None:
        """第 i 個檔案（None＝最近一個完成的）"""
        with self.lock:
            if i is None:
                done = [x for x in self.queue if x['state'] == 'done']
                return done[-1] if done else None
            return self.queue[i] if 0 <= i < len(self.queue) else None

    def snapshot(self) -> dict:
        with self.lock:
            elapsed = self.elapsed if self.state not in ('running', 'cancelling') else time.time() - self.t0
            eta = None
            if self.stage == 'transcribe' and self.progress > 0.03 and self.recog_t0:
                spent = time.time() - self.recog_t0
                eta = round(spent / self.progress * (1 - self.progress))
            elif self.stage == 'download' and self.download and self.download.get('speed'):
                d = self.download
                eta = round(max(d['total'] - d['done'], 0) / d['speed'])
            queue = [{'name': x['name'], 'src': x['src'], 'state': x['state'],
                      'summary': x['summary'], 'error': x['error']} for x in self.queue]
            return {'state': self.state, 'progress': self.progress, 'status': self.status_text,
                    'logs': list(self.logs), 'error': self.error, 'elapsed': round(elapsed, 1),
                    'summary': self.summary, 'device': self.device,
                    'stage': self.stage, 'stage_frac': self.stage_frac,
                    'download': self.download, 'eta': eta,
                    'queue': queue, 'index': self.index}

    def start(self, ps: list[dict]):
        self.reset()
        self.cancel.clear()
        self.state = 'running'
        self.t0 = time.time()
        self.queue = [{'src': str(p['src']), 'name': p['src'].name, 'state': 'pending',
                       'summary': None, 'error': None, 'result': None, 'full_cues': None}
                      for p in ps]
        if len(ps) > 1:
            self.log(f'佇列共 {len(ps)} 個檔案，依序辨識。')
        self.status('準備中…')
        self.thread = threading.Thread(target=self._work, args=(ps,), daemon=True)
        self.thread.start()

    def request_cancel(self):
        if self.busy:
            self.cancel.set()
            with self.lock:
                self.state = 'cancelling'
                self.status_text = '取消中…'

    def _work(self, ps: list[dict]):
        old_out, old_err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = _JobWriter(self, 'log'), _JobWriter(self, 'status')
        try:
            for i, p in enumerate(ps):
                if self.cancel.is_set():
                    break
                with self.lock:
                    self.index = i
                    self._reset_item()
                    self.status_text = '準備中…'
                    self.queue[i]['state'] = 'running'
                self._work_one(p, self.queue[i], i, len(ps))
        finally:
            sys.stdout, sys.stderr = old_out, old_err
            self._wrap_up()

    def _wrap_up(self):
        with self.lock:
            for x in self.queue:
                if x['state'] in ('pending', 'running'):
                    x['state'] = 'cancelled'
            ok = [x for x in self.queue if x['state'] == 'done']
            bad = [x for x in self.queue if x['state'] == 'error']
            self.elapsed = time.time() - self.t0
            if self.cancel.is_set():
                self.state = 'cancelled'
                self.status_text = '已取消' + (f'（已完成 {len(ok)} 個檔案）' if ok and len(self.queue) > 1 else '')
            elif len(self.queue) == 1:
                x = self.queue[0]
                self.state, self.error = x['state'], x['error']
                self.summary = x['summary']
                self.status_text = x['summary'] if ok else '失敗，詳見紀錄'
            else:
                self.state = 'done' if ok else 'error'
                self.summary = (f'佇列完成：{len(ok)} 個成功' + (f'，{len(bad)} 個失敗' if bad else '')
                                + f'，共耗時 {fmt_secs(self.elapsed)}')
                self.error = None if ok else (bad[0]['error'] if bad else None)
                self.status_text = self.summary
        if self.state == 'cancelled':
            self.log('已取消。')
        elif len(self.queue) > 1:
            self.log(self.summary)

    def _work_one(self, p: dict, item: dict, i: int, n: int):
        def prog(x: float):
            if self.cancel.is_set():
                raise Cancelled
            with self.lock:
                if self.stage != 'transcribe':
                    self.stage, self.recog_t0 = 'transcribe', time.time()
                    self.status_text = '辨識中…'
                self.progress = float(x)
                self.stage_frac = float(x)

        span = ''
        if p['start'] or p['end'] is not None:
            end = fmt_clock(p['end']) if p['end'] is not None else '結尾'
            span = f'，範圍 {fmt_clock(p["start"])} ~ {end}'
        head = f'[{i + 1}/{n}] ' if n > 1 else ''
        self.log(f'{head}辨識 {p["src"].name}（模型 {p["model"]}{span}）')
        if p['words'] and i == 0:
            self.log(f'詞庫載入 {len(p["words"])} 個詞')
        t0 = time.time()
        try:
            r = transcriber.transcribe(
                str(p['src']), model_size=p['model'], device=p['device'], lang=p['lang'],
                glossary_words=p['words'], to_taiwan=p['to_tw'], progress=prog,
                start_sec=p['start'], end_sec=p['end'], on_model=self._on_model,
                on_stage=self._on_stage)
            if self.cancel.is_set():
                raise Cancelled
            p['outdir'].mkdir(parents=True, exist_ok=True)
            files = write_outputs(r['cues'], p['outdir'], output_stem(p['src'], p['start'], p['end']))
            self._finish(r, files, p, item, time.time() - t0)
        except (Cancelled, models.DownloadCancelled):
            with self.lock:
                item['state'] = 'cancelled'
        except Exception as e:  # noqa: BLE001
            if isinstance(e, RuntimeError) and self.stage == 'download':
                msg = str(e)               # 下載錯誤已翻成人話（models.friendly_error）
            elif type(e).__module__.startswith('av') or 'Invalid data' in str(e):
                msg = '讀不到這個檔案：可能不是影音檔，或檔案已損毀'
            elif isinstance(e, ValueError) and '音訊軌' in str(e):
                msg = str(e)
            else:
                msg = f'{type(e).__name__}: {e}'
            self.log('失敗：' + msg)
            with self.lock:
                item['state'], item['error'] = 'error', msg

    def _on_stage(self, stage: str, frac, extra):
        if self.cancel.is_set():
            raise Cancelled
        texts = {'decode': '讀取音訊中…', 'load': '載入模型中…', 'wait': '等待另一個辨識工作完成…'}
        with self.lock:
            first = stage != self.stage
            self.stage, self.stage_frac = stage, frac
            if stage == 'download':
                self.download = dict(extra or {})
                self.status_text = '下載模型「' + models.info(self.download['model'])['label'] + '」…'
            else:
                self.status_text = texts.get(stage, self.status_text)
        if first and stage == 'download':
            m = models.info(extra['model'])
            self.log('第一次使用「%s」模型（%s），先下載 %.0f MB，之後離線可用。'
                     % (m['label'], extra['model'], extra['total'] / 1e6))
        elif first and stage == 'wait':
            self.log('字幕編輯器正在辨識，等它完成後開始。')
        elif first and stage == 'decode':
            self.log('讀取音訊…')
        elif first and stage == 'load':
            self.log('載入模型 %s…' % (extra or {}).get('model', ''))

    def _on_model(self, info: dict):
        with self.lock:
            self.device = info
        self.log(f'運算裝置：{info["device_label"]}（{info["compute_type"]}），模型 {info["model"]}')

    def _finish(self, r: dict, files: list[Path], p: dict, item: dict, elapsed: float):
        cues = r['cues']
        used = r.get('model_used', p['model'])
        note = '' if used == p['model'] else f'，記憶體不足改用 {used} 模型'
        # 裝置另外用標籤顯示，這裡不重複，避免狀態列被截斷
        summary = f'完成：{len(cues)} 句，語言 {r["language"]}，耗時 {elapsed:.0f} 秒{note}'
        self.log(summary)
        for f in files:
            self.log(f'輸出 {f}')
        result = {
            'cues': [{'start': c['start'], 'end': c['end'], 'text': c['text'],
                      'clock': fmt_clock(c['start'])} for c in cues],
            'files': [str(f) for f in files],
            'outdir': str(p['outdir']),
            'text': '\n'.join(c['text'] for c in cues),
            'language': r['language'], 'model_used': used,
            'elapsed': round(elapsed, 1), 'summary': summary,
            'device_used': r.get('device_used'), 'device_label': r.get('device_label', ''),
            'compute_type': r.get('compute_type'), 'name': p['src'].name,
        }
        with self.lock:
            self.progress = 1.0
            item.update(state='done', summary=summary, result=result,
                        full_cues=cues)   # 含詞級時間戳，給「用字幕編輯器打開」
            self.result = result
            self.status_text = summary


def fmt_secs(s: float) -> str:
    s = round(s)
    return f'{s // 60} 分 {s % 60} 秒' if s >= 60 else f'{s} 秒'


def open_folder(path: Path):
    path.mkdir(parents=True, exist_ok=True)
    if sys.platform == 'win32':
        os.startfile(path)  # noqa: S606
    elif sys.platform == 'darwin':
        subprocess.Popen(['open', str(path)])
    else:
        subprocess.Popen(['xdg-open', str(path)])


def set_clipboard(text: str) -> bool:
    """前端 navigator.clipboard 失敗時的後備：Windows 直接寫系統剪貼簿，其他平台走指令。"""
    try:
        if sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes
            k32, u32 = ctypes.windll.kernel32, ctypes.windll.user32
            k32.GlobalAlloc.restype = wintypes.HGLOBAL
            k32.GlobalLock.restype = wintypes.LPVOID
            k32.GlobalLock.argtypes = [wintypes.HGLOBAL]
            k32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
            u32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
            data = text.encode('utf-16-le') + b'\x00\x00'
            handle = k32.GlobalAlloc(0x0042, len(data))  # GMEM_MOVEABLE | GMEM_ZEROINIT
            ctypes.memmove(k32.GlobalLock(handle), data, len(data))
            k32.GlobalUnlock(handle)
            if not u32.OpenClipboard(None):
                return False
            try:
                u32.EmptyClipboard()
                u32.SetClipboardData(13, handle)  # CF_UNICODETEXT
            finally:
                u32.CloseClipboard()
            return True
        cmd = ['pbcopy'] if sys.platform == 'darwin' else ['xclip', '-selection', 'clipboard']
        subprocess.run(cmd, input=text.encode('utf-8'), check=True)
        return True
    except Exception:  # noqa: BLE001
        return False


class Api(EditorApi):
    """字幕編輯器 API（app.py）＋逐字稿轉檔 API（tx_*）。前端：window.pywebview.api.*"""

    def __init__(self, initial_view: str = 'transcribe'):
        super().__init__()
        self._initial_view = initial_view
        self._tx = TranscribeJob()
        self._dl_errors: dict[str, str] = {}
        self._outdir = DEFAULT_OUTDIR

    # ----- 視窗 / 一般 -----
    def get_info(self):
        return {'app': APP_TITLE, 'version': __version__, 'initial_view': self._initial_view,
                'settings': appinfo.load_settings(),
                'outdir': str(self._outdir), 'models': MODELS,
                'ffmpeg': exporter.has_ffmpeg(), 'platform': sys.platform,
                'compute': self.get_compute()}

    def get_compute(self, refresh: bool = False):
        """這台電腦可用的運算：GPU 能不能用、auto 會選哪個、各選項的顯示名稱"""
        info = dict(transcriber.compute_info(refresh=bool(refresh)))
        auto = 'cuda' if info['gpu_ok'] else 'cpu'
        info.update(auto=auto, cpu_label=transcriber.device_label('cpu'),
                    gpu_label=transcriber.device_label('cuda') if info['cuda_devices'] else '',
                    auto_label=transcriber.device_label(auto), hint=transcriber.CUDA_HINT)
        return info

    def open_folder(self, path: str = ''):
        try:
            open_folder(Path(path) if path else self._outdir)
            return {'ok': True}
        except OSError as e:
            return {'error': f'打不開資料夾：{e}'}

    def copy_text(self, text: str):
        return {'ok': set_clipboard(text or '')}

    # ----- 逐字稿轉檔：選檔 -----
    def _dialog(self, kind, **kw):
        import webview
        r = self._window.create_file_dialog(kind, **kw)
        if not r:
            return None
        return r if isinstance(r, str) else r[0]

    def tx_pick_media(self):
        """可多選；回傳路徑清單（沒選回 None）"""
        import webview
        r = self._window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=True,
                                            file_types=(MEDIA_FILTER, ALL_FILTER))
        if not r:
            return None
        return [r] if isinstance(r, str) else list(r)

    def tx_pick_folder(self):
        """選一個資料夾，回傳裡面所有影音檔（含子資料夾）"""
        import webview
        p = self._dialog(webview.FileDialog.FOLDER)
        return self.tx_expand([p]) if p else None

    def tx_expand(self, paths):
        """把拖進來或選到的路徑展開成影音檔清單：資料夾展開（含子資料夾），其他副檔名略過"""
        out, seen = [], set()
        for raw in paths or []:
            p = Path(str(raw))
            cands = sorted(x for x in p.rglob('*') if x.is_file()) if p.is_dir() else [p]
            for x in cands:
                key = str(x).lower()
                if x.suffix.lower() in MEDIA_EXTS and x.is_file() and key not in seen:
                    seen.add(key)
                    out.append(str(x))
                if len(out) >= MAX_QUEUE:
                    return out
        return out

    def tx_pick_glossary(self):
        import webview
        return self._dialog(webview.FileDialog.OPEN, file_types=('文字檔 (*.txt)', ALL_FILTER))

    def tx_pick_outdir(self):
        import webview
        p = self._dialog(webview.FileDialog.FOLDER, directory=str(self._outdir))
        if p:
            self._outdir = Path(p)
        return p

    # ----- 逐字稿轉檔：執行 -----
    def tx_start(self, params: dict):
        """params.files：一個或多個影音檔（舊版前端用 params.src）。
        只轉其中一段（start/end）只在單一檔案時套用。"""
        if self._tx.busy:
            return {'error': '已有轉檔進行中'}
        q = dict(params or {})
        files = q.get('files') or ([q['src']] if q.get('src') else [])
        if not files:
            return {'error': '請先選一個影音檔'}
        if len(files) > MAX_QUEUE:
            return {'error': f'一次最多 {MAX_QUEUE} 個檔案'}
        if len(files) > 1:
            q['start'] = q['end'] = ''
        try:
            ps = [self._collect({**q, 'src': f}) for f in files]
        except ValueError as e:
            return {'error': str(e)}
        self._outdir = ps[0]['outdir']
        self._tx.start(ps)
        return {'ok': True}

    def _collect(self, q: dict) -> dict:
        src = Path(str(q.get('src', '')).strip().strip('"'))
        if not src.is_file():
            raise ValueError('請先選一個存在的影音檔')
        s_raw, e_raw = str(q.get('start') or '').strip(), str(q.get('end') or '').strip()
        try:
            start = parse_time(s_raw) if s_raw else 0.0
            end = parse_time(e_raw) if e_raw else None
        except ValueError:
            raise ValueError('範圍格式看不懂，請寫成 13:00、1:02:03 或 780') from None
        if start < 0 or (end is not None and end < 0):
            raise ValueError('範圍不能是負數')
        if end is not None and end <= start:
            raise ValueError('「到」必須晚於「從」')
        words: list[str] = []
        gp = str(q.get('glossary') or '').strip().strip('"')
        if gp:
            try:
                words = [w.strip() for w in Path(gp).read_text(encoding='utf-8').splitlines()
                         if w.strip()]
            except (OSError, UnicodeDecodeError) as e:
                raise ValueError(f'讀不到詞庫檔：{e}') from None
        if q.get('use_glossary'):
            # 字幕編輯器累積的「我的詞庫」也一起用，兩頁的辨識結果才一致
            words += [w for w in self.glossary.words if w not in words]
        words = words or None
        model = str(q.get('model') or 'small')
        if model not in MODELS:
            raise ValueError(f'不認識的模型：{model}')
        device = str(q.get('device') or 'auto')
        if device not in ('cpu', 'cuda', 'auto'):
            raise ValueError(f'不認識的裝置：{device}')
        lang = str(q.get('lang') or '').strip() or None
        outdir = Path(str(q.get('outdir') or '').strip() or DEFAULT_OUTDIR)
        return {'src': src, 'start': start, 'end': end, 'words': words, 'model': model,
                'device': device, 'lang': lang, 'to_tw': bool(q.get('to_tw', True)),
                'outdir': outdir}

    def tx_poll(self):
        return self._tx.snapshot()

    def tx_result(self, i: int | None = None):
        x = self._tx.item(i)
        return x['result'] if x else None

    def tx_cancel(self):
        self._tx.request_cancel()
        return {'ok': True}

    def tx_busy(self):
        return self._tx.busy

    def tx_to_project(self, i: int | None = None):
        """把逐字稿轉檔的結果（第 i 個檔案，預設最近完成的）建成字幕編輯器專案（含詞級時間戳），
        回傳專案名稱"""
        x = self._tx.item(i)
        if not x or x['state'] != 'done' or not x.get('full_cues'):
            return {'error': '還沒有可以打開的轉檔結果'}
        base = Path(x['src']).stem
        existing = {p['name'] for p in self.store.list()}
        name, k = base, 2
        while name in existing:
            name, k = f'{base} ({k})', k + 1
        self.store.create(name, x['src'])
        data = self.store.load(name)
        data['cues'] = x['full_cues']
        data['language'] = (x['result'] or {}).get('language')
        self.store.save(name, data)
        return {'ok': True, 'name': name}

    # ----- 模型管理 -----
    def models_list(self):
        info = transcriber.compute_info()
        lst = models.status()
        for m in lst:
            m['error'] = self._dl_errors.get(m['id'])
        return {'root': str(models.root()), 'models': lst,
                'recommended': 'large-v3-turbo' if info.get('gpu_ok') else 'small',
                'used': sum(m['size_on_disk'] for m in lst)}

    def model_download(self, model_id: str):
        try:
            models.info(model_id)
        except ValueError as e:
            return {'error': str(e)}
        if model_id in models.active():
            return {'ok': True}
        self._dl_errors.pop(model_id, None)

        def run():
            try:
                models.download(model_id)
            except models.DownloadCancelled:
                pass
            except Exception as e:  # noqa: BLE001
                self._dl_errors[model_id] = str(e) if isinstance(e, RuntimeError) else models.friendly_error(e)
        threading.Thread(target=run, daemon=True).start()
        time.sleep(0.1)   # 讓下載狀態先登記，前端馬上輪詢就看得到
        return {'ok': True}

    def model_cancel(self, model_id: str):
        return {'ok': models.cancel(model_id)}

    def model_delete(self, model_id: str):
        if self._tx.busy:
            return {'error': '正在轉檔，請等轉檔結束再刪除模型'}
        try:
            freed = models.delete(model_id)
        except (RuntimeError, ValueError, OSError) as e:
            return {'error': str(e)}
        transcriber.release_model(model_id)
        return {'ok': True, 'freed': freed}

    def open_models_folder(self):
        return self.open_folder(str(models.root()))

    # ----- 關於、更新、設定 -----
    def about_info(self):
        bundle = Path(getattr(sys, '_MEIPASS', APP_DIR))
        notices = bundle / 'THIRD_PARTY_NOTICES.txt'
        import platform
        return {'version': __version__, 'dev': appinfo.is_dev_build(), 'flavor': appinfo.build_flavor(),
                'platform': f'{platform.system()} {platform.release()} ({platform.machine()})',
                'python': platform.python_version(), 'frozen': FROZEN,
                'data_dir': str(DATA_DIR), 'models_dir': str(models.root()),
                'log_dir': str(appinfo.LOG_DIR), 'output_dir': str(OUTPUT_DIR),
                'settings': appinfo.load_settings(),
                'notices': str(notices) if notices.exists() else None,
                'releases_url': appinfo.RELEASES_URL}

    def check_update(self, force: bool = False):
        return appinfo.check_update(force=bool(force))

    def set_setting(self, key: str, value):
        try:
            return {'ok': True, 'settings': appinfo.save_setting(key, value)}
        except (ValueError, OSError) as e:
            return {'error': str(e)}

    _URL_OK = ('https://github.com/alextixu/AutoSubtitle', 'https://go.microsoft.com/fwlink/',
               'https://huggingface.co/')

    def open_url(self, url: str):
        """只開白名單內的網址（更新下載頁、回報問題、WebView2 下載）"""
        if not any(str(url).startswith(p) for p in self._URL_OK):
            return {'error': '不允許的網址'}
        import webbrowser
        webbrowser.open(url)
        return {'ok': True}

    def open_logs_folder(self):
        return self.open_folder(str(appinfo.LOG_DIR))

    def open_notices(self):
        info = self.about_info()
        if not info['notices']:
            return self.open_url('https://github.com/alextixu/AutoSubtitle/blob/main/packaging/NOTICES_EXTRA.txt')
        p = info['notices']
        if sys.platform == 'win32':
            os.startfile(p)  # noqa: S606
        else:
            subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', p])
        return {'ok': True}

    def diagnostics(self):
        """回報問題用：版本、平台、運算、最後幾十行紀錄（不含影片內容）"""
        info = self.about_info()
        c = transcriber.compute_info()
        lines = [f'AutoSubtitle {info["version"]} ({info["flavor"]}{", 打包版" if info["frozen"] else ", 原始碼"})',
                 f'系統：{info["platform"]}，Python {info["python"]}',
                 f'運算：GPU {"可用" if c.get("gpu_ok") else "不可用"} {c.get("gpu_name") or ""} {c.get("reason") or ""}'.strip(),
                 '', '--- 最近的紀錄 ---', appinfo.tail_log(60)]
        return '\n'.join(lines)


def _fallback_error(msg: str):
    """沒裝 pywebview 時用內建 tkinter 顯示安裝提示（pythonw 啟動時看不到主控台）"""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(APP_NAME, msg)
        root.destroy()
    except Exception:  # noqa: BLE001
        print(msg, file=sys.stderr)


def selftest(media: str, out: str, model: str = 'tiny') -> int:
    """不開視窗跑一次完整辨識，結果寫成 JSON。給打包後的 CI 驗證用：
    確認 ctranslate2、PyAV、VAD 模型、OpenCC 字典都有包進去。"""
    import faulthandler
    import json
    import traceback
    report = {'ok': False, 'frozen': FROZEN, 'platform': sys.platform}
    # 診斷：每個階段寫一行到 <out>.log；卡住超過 AS_SELFTEST_TIMEOUT 秒就印出所有執行緒的堆疊並結束
    log = open(out + '.log', 'w', encoding='utf-8', buffering=1)  # noqa: SIM115
    stage = lambda msg: log.write(f'{time.strftime("%H:%M:%S")} {msg}\n')  # noqa: E731
    faulthandler.dump_traceback_later(float(os.environ.get('AS_SELFTEST_TIMEOUT', '600')),
                                      exit=True, file=log)
    try:
        stage('compute_info')
        report['compute'] = transcriber.compute_info()
        stage(f'compute {report["compute"]}')
        last = [-1]

        def prog(x):
            if int(x * 10) != last[0]:
                last[0] = int(x * 10)
                stage(f'progress {x:.0%}')

        def on_model(info):
            stage(f'model loaded {info}')

        stage(f'transcribe start model={model}')
        r = transcriber.transcribe(media, model_size=model, device='auto', lang='zh',
                                   progress=prog, on_model=on_model)
        stage('transcribe done')
        report.update(ok=bool(r['cues']), cues=len(r['cues']), language=r['language'],
                      device=r.get('device_label'), compute_type=r.get('compute_type'),
                      first=r['cues'][0]['text'] if r['cues'] else '')
        from opencc import OpenCC
        report['opencc'] = OpenCC('s2twp').convert('软件')
        report['ui_exists'] = ui_file().exists()
        report['ok'] = report['ok'] and report['ui_exists'] and report['opencc'] == '軟體'
    except Exception:  # noqa: BLE001
        report['error'] = traceback.format_exc()
    faulthandler.cancel_dump_traceback_later()
    stage(f'finished ok={report["ok"]}')
    log.close()
    Path(out).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    return 0 if report['ok'] else 1


def uitest(out: str, timeout: float = 90.0) -> int:
    """開真正的視窗，確認介面載入、前後端 API 接上，然後自動關閉。給打包後的 CI 驗證用。
    環境變數 AS_UITEST_SHOT 給一個 .png 路徑時，macOS 會順便截一張螢幕。"""
    import json
    import webview
    report = {'ok': False, 'frozen': FROZEN, 'platform': sys.platform}
    api = Api(initial_view='transcribe')
    win = webview.create_window(APP_TITLE, str(ui_file()), js_api=api, width=1180, height=800,
                                background_color='#f5f5f7')
    api._window = win
    probe = ("JSON.stringify({api: !!(window.pywebview && window.pywebview.api && window.pywebview.api.tx_start),"
             " outdir: (document.getElementById('txOutdir') || {}).textContent || '',"
             " compute: (document.getElementById('sideComputeName') || {}).textContent || '',"
             " title: document.title})")

    def run():
        t0 = time.time()
        try:
            while time.time() - t0 < timeout:
                try:
                    raw = win.evaluate_js(probe)
                    d = json.loads(raw) if isinstance(raw, str) else (raw or {})
                    report['last'] = d
                    if d.get('api') and d.get('outdir') and d.get('compute') not in ('', '偵測中…'):
                        report.update(d, ok=True, seconds=round(time.time() - t0, 1))
                        break
                except Exception as e:  # noqa: BLE001
                    report['last_error'] = repr(e)
                time.sleep(0.5)
            shot = os.environ.get('AS_UITEST_SHOT')
            if shot and sys.platform == 'darwin':
                time.sleep(1.5)
                subprocess.run(['screencapture', '-x', shot], check=False)
        finally:
            Path(out).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
            win.destroy()

    webview.start(run)
    return 0 if report['ok'] else 1


def _hard_exit(code: int = 0):
    """直接結束程序。打包後的 macOS 版在 Python 正常收尾時，會卡在辨識引擎留下的
    背景執行緒上，視窗關了程式卻還在。工作都已完成、檔案也寫好了，所以跳過收尾。"""
    for f in (sys.stdout, sys.stderr):
        try:
            f.flush()
        except Exception:  # noqa: BLE001
            pass
    os._exit(code)


def _startup_bg() -> str:
    """視窗底色跟著系統主題，避免深色模式啟動時先閃一下白"""
    if sys.platform == 'win32':
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r'Software\Microsoft\Windows\Themes\Personalize') as k:
                light, _ = winreg.QueryValueEx(k, 'AppsUseLightTheme')
                return '#f5f5f7' if light else '#1c1c1e'
        except OSError:
            pass
    elif sys.platform == 'darwin':
        try:
            import subprocess as sp
            r = sp.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], capture_output=True, text=True, timeout=2)
            return '#1c1c1e' if 'Dark' in r.stdout else '#f5f5f7'
        except Exception:  # noqa: BLE001
            pass
    return '#f5f5f7'


def _check_webview2():
    """Windows 沒有 WebView2 Runtime 時，視窗會是空白或直接失敗；先提醒並提供下載頁"""
    if appinfo.webview2_installed() is not False:
        return
    appinfo.write_log('找不到 WebView2 Runtime')
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        go = messagebox.askyesno(APP_NAME, '這台電腦沒有安裝 Microsoft Edge WebView2 Runtime，'
                                 'AutoSubtitle 的介面需要它。\n\n要開啟下載頁嗎？（免費，約 2 MB）')
        root.destroy()
        if go:
            import webbrowser
            webbrowser.open('https://go.microsoft.com/fwlink/p/?LinkId=2124703')
    except Exception:  # noqa: BLE001
        pass


def main(default_view: str = 'transcribe'):
    if '--version' in sys.argv:
        print(f'{APP_NAME} {__version__}')
        return
    appinfo.setup_logging()
    if '--uitest' in sys.argv:
        _hard_exit(uitest(sys.argv[sys.argv.index('--uitest') + 1]))
    if '--selftest' in sys.argv:
        i = sys.argv.index('--selftest')
        model = sys.argv[i + 3] if len(sys.argv) > i + 3 else 'tiny'
        _hard_exit(selftest(sys.argv[i + 1], sys.argv[i + 2], model))
    view = default_view
    for a in sys.argv[1:]:
        if a in ('transcribe', 'editor'):
            view = a
    try:
        import webview
    except ImportError:
        _fallback_error('字幕工房需要 pywebview：\n\npip install -r requirements.txt')
        return
    api = Api(initial_view=view)
    win = webview.create_window(
        APP_TITLE, str(ui_file()), js_api=api,
        width=1280, height=840, min_size=(980, 660), text_select=True,
        background_color=_startup_bg())
    api._window = win

    def flush_editor():
        """關閉前把編輯器裡還沒存的內容直接寫檔（不靠前端的非同步存檔）"""
        try:
            raw = win.evaluate_js('window.__asDumpProject ? window.__asDumpProject() : null')
            if raw:
                import json
                d = json.loads(raw) if isinstance(raw, str) else raw
                api.save_project(d['name'], d['cues'], d['style'], d.get('scenes'))
        except Exception as e:  # noqa: BLE001
            appinfo.write_log(f'關閉前存檔失敗：{e}')

    def on_closing():
        busy = api.tx_busy() or api.editor_busy()
        if busy:
            ok = win.create_confirmation_dialog(APP_NAME, '還在辨識，確定要中止並關閉？')
            if not ok:
                return False
            api.tx_cancel()
            api.cancel_transcribe()
        flush_editor()
        return True

    def on_drop(e):
        """拖放檔案：pywebview 只在 Python 端的 DOM 事件裡給完整路徑，轉交給前端"""
        try:
            files = (e.get('dataTransfer') or {}).get('files') or []
            paths = [f.get('pywebviewFullPath') for f in files if f.get('pywebviewFullPath')]
            if paths:
                import json
                win.evaluate_js(f'window.__asDrop && window.__asDrop({json.dumps(paths)})')
        except Exception as ex:  # noqa: BLE001
            appinfo.write_log(f'拖放處理失敗：{ex}')

    def on_loaded():
        try:
            win.dom.document.events.drop += on_drop
        except Exception as ex:  # noqa: BLE001
            appinfo.write_log(f'無法註冊拖放事件：{ex}')

    win.events.closing += on_closing
    win.events.loaded += on_loaded
    _check_webview2()
    webview.start(debug='--debug' in sys.argv)
    if FROZEN:
        _hard_exit(0)


if __name__ == '__main__':
    main()
