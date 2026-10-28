# -*- coding: utf-8 -*-
"""appinfo — 設定檔、紀錄檔、崩潰紀錄、更新檢查。

  設定    <資料夾>/settings.json      例如 {"check_updates": true}
  紀錄    <資料夾>/logs/autosubtitle.log（超過 1 MB 輪替，保留 5 份）
  崩潰    <資料夾>/logs/crash.log（faulthandler：原生崩潰的堆疊）
  更新    每天最多查一次 GitHub Releases，結果快取在 <資料夾>/update.json
"""
from __future__ import annotations

import faulthandler
import json
import os
import platform
import sys
import threading
import time
import traceback
from pathlib import Path

from engine._version import __version__
from engine.paths import DATA_DIR, FROZEN

REPO = 'alextixu/AutoSubtitle'
RELEASES_URL = f'https://github.com/{REPO}/releases'
ISSUES_URL = f'https://github.com/{REPO}/issues/new'
LOG_DIR = DATA_DIR / 'logs'
LOG_FILE = LOG_DIR / 'autosubtitle.log'
CRASH_FILE = LOG_DIR / 'crash.log'
SETTINGS_FILE = DATA_DIR / 'settings.json'
UPDATE_CACHE = DATA_DIR / 'update.json'
DEFAULTS = {'check_updates': True, 'onboarded': False}
_crash_fp = None


# ---------- 設定 ----------

def load_settings() -> dict:
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding='utf-8'))
        return {**DEFAULTS, **(data if isinstance(data, dict) else {})}
    except (OSError, ValueError):
        return dict(DEFAULTS)


def save_setting(key: str, value) -> dict:
    if key not in DEFAULTS:
        raise ValueError(f'不認識的設定：{key}')
    s = load_settings()
    s[key] = value
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(tmp, SETTINGS_FILE)
    return s


# ---------- 紀錄與崩潰 ----------

def _rotate(path: Path, keep: int = 5, max_bytes: int = 1_000_000):
    try:
        if not path.exists() or path.stat().st_size < max_bytes:
            return
        for i in range(keep - 1, 0, -1):
            src = path.with_name(f'{path.name}.{i}')
            if src.exists():
                os.replace(src, path.with_name(f'{path.name}.{i + 1}'))
        os.replace(path, path.with_name(f'{path.name}.1'))
    except OSError:
        pass


def setup_logging():
    """打包版沒有主控台：stdout/stderr 改寫進紀錄檔。原始碼執行時保留主控台輸出。
    兩種情況都會啟用 faulthandler 與未捕捉例外的紀錄。"""
    global _crash_fp
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        _rotate(LOG_FILE)
        _rotate(CRASH_FILE, keep=3, max_bytes=500_000)
    except OSError:
        return
    if sys.stdout is None or sys.stderr is None:
        try:
            log = open(LOG_FILE, 'a', encoding='utf-8', buffering=1)  # noqa: SIM115
        except OSError:
            log = open(os.devnull, 'w', encoding='utf-8')  # noqa: SIM115
        if sys.stdout is None:
            sys.stdout = log
        if sys.stderr is None:
            sys.stderr = log
    try:
        _crash_fp = open(CRASH_FILE, 'a', encoding='utf-8', buffering=1)  # noqa: SIM115
        faulthandler.enable(file=_crash_fp, all_threads=True)
    except (OSError, RuntimeError):
        _crash_fp = None

    def log_exc(kind, exc_type, exc, tb):
        text = ''.join(traceback.format_exception(exc_type, exc, tb))
        write_log(f'[{kind}] 未處理的錯誤\n{text}')

    sys.excepthook = lambda t, e, tb: log_exc('main', t, e, tb)
    threading.excepthook = lambda a: log_exc(f'thread {a.thread.name if a.thread else "?"}',
                                             a.exc_type, a.exc_value, a.exc_traceback)
    write_log(f'啟動 AutoSubtitle {__version__}（{platform.platform()}，Python {platform.python_version()}，'
              f'{"打包版" if FROZEN else "原始碼"}）')


def write_log(text: str):
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {text}\n')
    except OSError:
        pass


def tail_log(lines: int = 60) -> str:
    try:
        return '\n'.join(LOG_FILE.read_text(encoding='utf-8', errors='replace').splitlines()[-lines:])
    except OSError:
        return ''


# ---------- 更新檢查 ----------

def _parse(v: str):
    from packaging.version import InvalidVersion, Version
    try:
        return Version(v.lstrip('v'))
    except InvalidVersion:
        return None


def is_dev_build() -> bool:
    v = _parse(__version__)
    return v is None or v.is_devrelease or v.local is not None or __version__.startswith('0.0.0')


def build_flavor() -> str:
    """這份程式對應 Release 上的哪個檔案"""
    if sys.platform == 'darwin':
        return 'macOS-Apple-Silicon' if platform.machine() == 'arm64' else 'macOS-Intel'
    gpu = FROZEN and (Path(getattr(sys, '_MEIPASS', '')) / 'nvidia').is_dir()
    return 'Windows-NVIDIA-GPU' if gpu else 'Windows'


def _pick_asset(assets: list[dict], flavor: str) -> dict | None:
    names = {a.get('name', ''): a for a in assets}
    if flavor.startswith('Windows'):
        for n, a in names.items():                         # 安裝版優先
            if n.endswith(f'-{flavor}-Setup.exe'):
                return a
        for n, a in names.items():
            if n.endswith(f'-{flavor}.zip'):
                return a
    else:
        for n, a in names.items():
            if n.endswith(f'-{flavor}.dmg'):
                return a
    return None


def check_update(force: bool = False, timeout: float = 8.0) -> dict:
    """回傳 {current, latest, newer, url, asset_name, asset_url, notes, checked_at, skipped, error}"""
    out = {'current': __version__, 'latest': None, 'newer': False, 'url': RELEASES_URL,
           'asset_name': None, 'asset_url': None, 'notes': '', 'checked_at': None,
           'skipped': None, 'error': None, 'dev': is_dev_build()}
    if not force:
        if not load_settings().get('check_updates', True):
            return {**out, 'skipped': 'disabled'}
        try:
            cached = json.loads(UPDATE_CACHE.read_text(encoding='utf-8'))
            if time.time() - cached.get('checked_ts', 0) < 86400 and cached.get('current') == __version__:
                return {**out, **cached.get('result', {}), 'skipped': 'cached'}
        except (OSError, ValueError):
            pass
    import urllib.error
    import urllib.request
    from engine.models import _ssl_context
    try:
        req = urllib.request.Request(f'https://api.github.com/repos/{REPO}/releases/latest',
                                     headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'AutoSubtitle'})
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as r:  # noqa: S310
            rel = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {**out, 'error': '還沒有發佈任何版本'}
        return {**out, 'error': f'檢查更新失敗（HTTP {e.code}）'}
    except Exception as e:  # noqa: BLE001
        return {**out, 'error': f'無法連線檢查更新（{type(e).__name__}）'}
    latest = (rel.get('tag_name') or '').lstrip('v')
    cur_v, new_v = _parse(__version__), _parse(latest)
    newer = bool(new_v and cur_v and new_v > cur_v and not is_dev_build())
    asset = _pick_asset(rel.get('assets') or [], build_flavor())
    result = {'latest': latest, 'newer': newer, 'url': rel.get('html_url') or RELEASES_URL,
              'asset_name': asset.get('name') if asset else None,
              'asset_url': asset.get('browser_download_url') if asset else None,
              'notes': (rel.get('body') or '')[:2000],
              'checked_at': time.strftime('%Y-%m-%d %H:%M')}
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        UPDATE_CACHE.write_text(json.dumps({'checked_ts': time.time(), 'current': __version__,
                                            'result': result}, ensure_ascii=False), encoding='utf-8')
    except OSError:
        pass
    return {**out, **result}


def webview2_installed() -> bool | None:
    """Windows：WebView2 Runtime 是否已安裝（None 代表無法判斷或不是 Windows）"""
    if sys.platform != 'win32':
        return None
    import winreg
    key = r'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    for hive, path in ((winreg.HKEY_LOCAL_MACHINE, 'SOFTWARE\\WOW6432Node\\' + key),
                       (winreg.HKEY_LOCAL_MACHINE, 'SOFTWARE\\' + key),
                       (winreg.HKEY_CURRENT_USER, 'SOFTWARE\\' + key)):
        try:
            with winreg.OpenKey(hive, path) as k:
                v, _ = winreg.QueryValueEx(k, 'pv')
                if v and v != '0.0.0.0':
                    return True
        except OSError:
            continue
    return False
