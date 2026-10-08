#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""app.py — 字幕編輯器後端（pywebview API）＋ 127.0.0.1 媒體伺服器

啟動：  python gui.py（主視窗，含逐字稿轉檔與字幕編輯器）
        python app.py 等同 python gui.py editor，開啟後直接停在編輯器
冒煙測試（不開視窗）：  python app.py --check

後端 API 由 Api 類別提供給前端 js（window.pywebview.api.*）。
影片播放走內建的 127.0.0.1 媒體伺服器（只服務已註冊的檔案，支援 Range 快轉）。
"""
from __future__ import annotations
import http.server
import json
import secrets
import socket
import socketserver
import sys
import threading
from pathlib import Path

APP_DIR = Path(__file__).parent
sys.path.insert(0, str(APP_DIR))

from engine import exporter, media, transcriber          # noqa: E402
from engine.paths import DATA_DIR                         # noqa: E402
from engine.glossary import Glossary                      # noqa: E402
from engine.projects import ProjectStore                  # noqa: E402


# ---------- 本機伺服器：不查主機全名 ----------
# http.server 啟動時會呼叫 socket.getfqdn() 查主機全名。macOS 上這個查詢會走 mDNS，
# 系統因此跳出「允許尋找區域網路上的裝置？」的權限提示，但這個程式只用 127.0.0.1。
# pywebview 內建的伺服器也繼承 HTTPServer，所以直接改掉 HTTPServer.server_bind。
def _bind_without_fqdn(self):
    socketserver.TCPServer.server_bind(self)
    self.server_name = 'localhost'
    self.server_port = self.server_address[1]


http.server.HTTPServer.server_bind = _bind_without_fqdn


# ---------- 本機媒體伺服器（只服務註冊過的檔案）----------

class _MediaHandler(http.server.BaseHTTPRequestHandler):
    registry: dict[str, Path] = {}

    def log_message(self, *a):  # 安靜
        pass

    def do_GET(self):
        token = self.path.lstrip('/').split('?')[0]
        path = self.registry.get(token)
        if not path or not path.exists():
            self.send_error(404)
            return
        size = path.stat().st_size
        start, end = 0, size - 1
        rng = self.headers.get('Range')
        status = 200
        if rng and rng.startswith('bytes='):
            try:
                s, e = rng[6:].split('-')
                start = int(s) if s else 0
                end = int(e) if e else size - 1
                status = 206
            except ValueError:
                pass
        length = end - start + 1
        ctype = 'video/mp4'
        suffix = path.suffix.lower()
        if suffix in ('.wav',):
            ctype = 'audio/wav'
        elif suffix in ('.mp3',):
            ctype = 'audio/mpeg'
        elif suffix in ('.ttf', '.otf', '.woff', '.woff2'):
            ctype = 'font/' + suffix[1:]
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(length))
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (ConnectionAbortedError, BrokenPipeError):
                    break
                remaining -= len(chunk)


class MediaServer:
    def __init__(self):
        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _MediaHandler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def register(self, path: str) -> str:
        p = Path(path).resolve()
        for tok, existing in _MediaHandler.registry.items():
            if existing == p:
                return f'http://127.0.0.1:{self.port}/{tok}'
        token = secrets.token_urlsafe(12)
        _MediaHandler.registry[token] = p
        return f'http://127.0.0.1:{self.port}/{token}'


# ---------- 前端 API ----------

class Api:
    def __init__(self):
        # 原始碼執行時放在專案資料夾；打包後放在使用者資料夾（見 engine/paths.py）
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.store = ProjectStore(DATA_DIR / 'projects')
        self.glossary = Glossary(DATA_DIR / 'glossary.json')
        self.styles_path = DATA_DIR / 'styles.json'
        self.server = MediaServer()
        self._job: dict = {'state': 'idle', 'progress': 0.0, 'error': None, 'project': None}
        self._window = None  # gui.main() 塞入；加底線是為了不讓 pywebview 把視窗物件當 API 掃描

    # ----- 專案 -----
    def list_projects(self):
        return self.store.list()

    def create_project(self, name, media_path):
        self.store.create(name, media_path)
        return {'ok': True}

    def open_project(self, name):
        data = self.store.load(name)
        if data is None:
            return {'error': '找不到專案'}
        data['media_url'] = self.server.register(data['media']) if Path(data['media']).exists() else None
        data['name'] = name
        return data

    def save_project(self, name, cues, style, scenes=None):
        data = self.store.load(name) or {}
        data['cues'] = cues
        data['style'] = style
        if scenes is not None:
            data['scenes'] = scenes
        self.store.save(name, data)
        return {'ok': True}

    def delete_project(self, name):
        self.store.delete(name)
        return {'ok': True}

    def pick_media(self):
        import webview
        r = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            file_types=('影音檔 (*.mp4;*.mov;*.mkv;*.webm;*.mp3;*.wav;*.m4a)', '所有檔案 (*.*)'))
        return r[0] if r else None

    def pick_font(self):
        import webview
        r = self._window.create_file_dialog(
            webview.OPEN_DIALOG, file_types=('字型檔 (*.ttf;*.otf;*.woff;*.woff2)',))
        if not r:
            return None
        return {'path': r[0], 'url': self.server.register(r[0]),
                'name': Path(r[0]).stem}

    # ----- 辨識（背景執行，前端輪詢 get_job）-----
    def start_transcribe(self, name, model_size='small'):
        if self._job['state'] == 'running':
            return {'error': '已有辨識進行中'}
        data = self.store.load(name)
        if not data or not Path(data['media']).exists():
            return {'error': '找不到媒體檔'}
        self._job = {'state': 'running', 'progress': 0.0, 'error': None, 'project': name,
                     'device': None}

        def run():
            try:
                r = transcriber.transcribe(
                    data['media'], model_size=model_size, device='auto',
                    glossary_words=self.glossary.words,
                    progress=lambda p: self._job.update(progress=p),
                    on_model=lambda info: self._job.update(device=info))
                data['cues'] = r['cues']
                data['language'] = r['language']
                self.store.save(name, data)
                self._job.update(state='done', progress=1.0)
            except Exception as e:  # noqa: BLE001
                self._job.update(state='error', error=str(e))

        threading.Thread(target=run, daemon=True).start()
        return {'ok': True}

    def get_job(self):
        return self._job

    # ----- 波形 / 切點 -----
    def get_waveform(self, name):
        data = self.store.load(name)
        cache = self.store._dir(name) / 'waveform.json'
        if cache.exists():
            return json.loads(cache.read_text(encoding='utf-8'))
        wf = media.waveform_peaks(data['media'])
        cache.write_text(json.dumps(wf), encoding='utf-8')
        return wf

    def detect_scenes(self, name):
        data = self.store.load(name)
        cuts = media.detect_scenes(data['media'])
        data['scenes'] = cuts
        self.store.save(name, data)
        return cuts

    # ----- 詞庫 -----
    def glossary_list(self):
        return self.glossary.words

    def glossary_add(self, word):
        return {'added': self.glossary.add(word)}

    def glossary_remove(self, word):
        self.glossary.remove(word)
        return {'ok': True}

    def learn_from_edit(self, old, new):
        return self.glossary.learn_from_edit(old, new)

    # ----- 樣式收藏牆（英雄牆本機版）-----
    def styles_list(self):
        if self.styles_path.exists():
            return json.loads(self.styles_path.read_text(encoding='utf-8'))
        return []

    def styles_save(self, name, style):
        items = self.styles_list()
        items = [s for s in items if s['name'] != name]
        items.insert(0, {'name': name, 'style': style})
        self.styles_path.write_text(json.dumps(items, ensure_ascii=False, indent=1),
                                    encoding='utf-8')
        return {'ok': True}

    def styles_delete(self, name):
        items = [s for s in self.styles_list() if s['name'] != name]
        self.styles_path.write_text(json.dumps(items, ensure_ascii=False, indent=1),
                                    encoding='utf-8')
        return {'ok': True}

    # ----- 匯出 -----
    def has_ffmpeg(self):
        return exporter.has_ffmpeg()

    def export_subtitle(self, name, fmt, style=None):
        import webview
        data = self.store.load(name)
        default = Path(data['media']).stem + '.' + fmt
        r = self._window.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=default)
        if not r:
            return {'cancelled': True}
        out = r if isinstance(r, str) else r[0]
        exporter.export_file(data['cues'], fmt, out, style)
        return {'ok': True, 'path': out}

    def burn_video(self, name, style=None):
        import webview
        data = self.store.load(name)
        default = Path(data['media']).stem + '_subtitled.mp4'
        r = self._window.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=default)
        if not r:
            return {'cancelled': True}
        out = r if isinstance(r, str) else r[0]
        ok, msg = exporter.burn_video(data['media'], data['cues'], out, style)
        return {'ok': ok, 'msg': msg}


def main():
    if '--check' in sys.argv:
        # 冒煙測試：不開視窗，驗證 API 與伺服器可初始化
        api = Api()
        print('projects:', len(api.list_projects()))
        print('glossary:', len(api.glossary_list()), 'words')
        print('styles:', len(api.styles_list()))
        print('media server port:', api.server.port)
        print('ffmpeg:', api.has_ffmpeg())
        print('CHECK OK')
        return
    # 視窗統一由 gui.py 開（單一視窗，左側切換功能）；這裡只是捷徑，直接停在編輯器
    from gui import main as gui_main
    gui_main(default_view='editor')


if __name__ == '__main__':
    main()
