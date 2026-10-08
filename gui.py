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
from engine import exporter, transcriber                                   # noqa: E402
from engine.paths import DATA_DIR, FROZEN, OUTPUT_DIR, ui_file             # noqa: E402
from transcribe import fmt_clock, output_stem, parse_time, write_outputs   # noqa: E402

APP_NAME = 'AutoSubtitle'
APP_TITLE = 'AutoSubtitle 字幕工房'
DEFAULT_OUTDIR = OUTPUT_DIR
MEDIA_FILTER = '影音檔 (*.mp4;*.mov;*.mkv;*.webm;*.avi;*.mp3;*.wav;*.m4a;*.aac;*.flac)'
ALL_FILTER = '所有檔案 (*.*)'
MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']
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
    """一次逐字稿轉檔工作：背景執行緒跑辨識，前端用 tx_poll 輪詢。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.thread: threading.Thread | None = None
        self.reset()

    def reset(self):
        self.state = 'idle'        # idle / running / cancelling / done / cancelled / error
        self.progress = 0.0
        self.status_text = ''
        self.logs: list[str] = []
        self.error: str | None = None
        self.result: dict | None = None
        self.t0 = 0.0
        self.elapsed = 0.0
        self.device: dict | None = None   # 實際使用的運算裝置（模型載入後才知道）

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

    def snapshot(self) -> dict:
        with self.lock:
            elapsed = self.elapsed if self.state not in ('running', 'cancelling') else time.time() - self.t0
            return {'state': self.state, 'progress': self.progress, 'status': self.status_text,
                    'logs': list(self.logs), 'error': self.error, 'elapsed': round(elapsed, 1),
                    'summary': (self.result or {}).get('summary'), 'device': self.device}

    def start(self, p: dict):
        self.reset()
        self.cancel.clear()
        self.state = 'running'
        self.t0 = time.time()
        span = ''
        if p['start'] or p['end'] is not None:
            end = fmt_clock(p['end']) if p['end'] is not None else '結尾'
            span = f'，範圍 {fmt_clock(p["start"])} ~ {end}'
        self.log(f'辨識 {p["src"].name}（模型 {p["model"]}{span}）')
        if p['words']:
            self.log(f'詞庫載入 {len(p["words"])} 個詞')
        self.log('第一次用某個模型會先下載模型檔，之後離線可用。')
        self.status('載入模型中…')
        self.thread = threading.Thread(target=self._work, args=(p,), daemon=True)
        self.thread.start()

    def request_cancel(self):
        if self.busy:
            self.cancel.set()
            with self.lock:
                self.state = 'cancelling'
                self.status_text = '取消中…（等目前這句辨識完）'

    def _work(self, p: dict):
        def prog(x: float):
            if self.cancel.is_set():
                raise Cancelled
            with self.lock:
                self.progress = float(x)

        old_out, old_err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = _JobWriter(self, 'log'), _JobWriter(self, 'status')
        try:
            r = transcriber.transcribe(
                str(p['src']), model_size=p['model'], device=p['device'], lang=p['lang'],
                glossary_words=p['words'], to_taiwan=p['to_tw'], progress=prog,
                start_sec=p['start'], end_sec=p['end'], on_model=self._on_model)
            if self.cancel.is_set():
                raise Cancelled
            p['outdir'].mkdir(parents=True, exist_ok=True)
            files = write_outputs(r['cues'], p['outdir'], output_stem(p['src'], p['start'], p['end']))
            self._finish(r, files, p)
        except Cancelled:
            with self.lock:
                self.state, self.elapsed = 'cancelled', time.time() - self.t0
                self.status_text = '已取消'
            self.log('已取消。')
        except Exception as e:  # noqa: BLE001
            msg = f'{type(e).__name__}: {e}'
            self.log('失敗：' + msg)
            with self.lock:
                self.state, self.error, self.elapsed = 'error', msg, time.time() - self.t0
                self.status_text = '失敗，詳見紀錄'
        finally:
            sys.stdout, sys.stderr = old_out, old_err

    def _on_model(self, info: dict):
        with self.lock:
            self.device = info
        self.log(f'運算裝置：{info["device_label"]}（{info["compute_type"]}），模型 {info["model"]}')

    def _finish(self, r: dict, files: list[Path], p: dict):
        cues = r['cues']
        used = r.get('model_used', p['model'])
        note = '' if used == p['model'] else f'，記憶體不足改用 {used} 模型'
        elapsed = time.time() - self.t0
        dev = r.get('device_label', '')
        # 裝置另外用標籤顯示，這裡不重複，避免狀態列被截斷
        summary = f'完成：{len(cues)} 句，語言 {r["language"]}，耗時 {elapsed:.0f} 秒{note}'
        self.log(summary)
        for f in files:
            self.log(f'輸出 {f}')
        with self.lock:
            self.progress, self.elapsed = 1.0, elapsed
            self.result = {
                'cues': [{'start': c['start'], 'end': c['end'], 'text': c['text'],
                          'clock': fmt_clock(c['start'])} for c in cues],
                'files': [str(f) for f in files],
                'outdir': str(p['outdir']),
                'text': '\n'.join(c['text'] for c in cues),
                'language': r['language'], 'model_used': used,
                'elapsed': round(elapsed, 1), 'summary': summary,
                'device_used': r.get('device_used'), 'device_label': dev,
                'compute_type': r.get('compute_type'),
            }
            self.state, self.status_text = 'done', summary


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
        self._outdir = DEFAULT_OUTDIR

    # ----- 視窗 / 一般 -----
    def get_info(self):
        return {'app': APP_TITLE, 'initial_view': self._initial_view,
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
        import webview
        return self._dialog(webview.FileDialog.OPEN, file_types=(MEDIA_FILTER, ALL_FILTER))

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
        if self._tx.busy:
            return {'error': '已有轉檔進行中'}
        try:
            p = self._collect(params or {})
        except ValueError as e:
            return {'error': str(e)}
        self._outdir = p['outdir']
        self._tx.start(p)
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
        words = None
        gp = str(q.get('glossary') or '').strip().strip('"')
        if gp:
            try:
                words = [w.strip() for w in Path(gp).read_text(encoding='utf-8').splitlines()
                         if w.strip()]
            except (OSError, UnicodeDecodeError) as e:
                raise ValueError(f'讀不到詞庫檔：{e}') from None
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

    def tx_result(self):
        with self._tx.lock:
            return self._tx.result

    def tx_cancel(self):
        self._tx.request_cancel()
        return {'ok': True}

    def tx_busy(self):
        return self._tx.busy


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


def _quiet_streams():
    """打包成視窗程式後沒有主控台，sys.stdout/stderr 會是 None。
    模型下載的進度條寫到 None 會當掉，所以改寫進使用者資料夾的 log。"""
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        log = open(DATA_DIR / 'autosubtitle.log', 'a', encoding='utf-8', buffering=1)  # noqa: SIM115
    except OSError:
        log = open(os.devnull, 'w', encoding='utf-8')  # noqa: SIM115
    if sys.stdout is None:
        sys.stdout = log
    if sys.stderr is None:
        sys.stderr = log


def main(default_view: str = 'transcribe'):
    _quiet_streams()
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
        background_color='#f5f5f7')
    api._window = win

    def on_closing():
        if not api.tx_busy():
            return True
        ok = win.create_confirmation_dialog(APP_NAME, '還在轉檔，確定要中止並關閉？')
        if ok:
            api.tx_cancel()
        return bool(ok)

    win.events.closing += on_closing
    webview.start(debug='--debug' in sys.argv)
    if FROZEN:
        _hard_exit(0)


if __name__ == '__main__':
    main()
