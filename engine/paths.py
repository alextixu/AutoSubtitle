# -*- coding: utf-8 -*-
"""paths — 程式資源與使用者資料放在哪裡。

從原始碼執行（python gui.py）時，一切都在專案資料夾，跟以前一樣。
打包成 Windows .exe 或 macOS .app 時，程式所在的資料夾可能是唯讀的
（例如 /Applications 裡的 .app），所以使用者資料改放系統慣用的位置：

  Windows  %APPDATA%\\AutoSubtitle            專案、詞庫、樣式
           文件\\AutoSubtitle                 逐字稿輸出
  macOS    ~/Library/Application Support/AutoSubtitle
           ~/Documents/AutoSubtitle
  Linux    ~/.local/share/AutoSubtitle（或 $XDG_DATA_HOME）
           ~/Documents/AutoSubtitle
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = 'AutoSubtitle'
FROZEN = bool(getattr(sys, 'frozen', False))

# 程式自帶的檔案（ui/ 介面）：打包後 PyInstaller 會解到 sys._MEIPASS
RESOURCE_DIR = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent.parent))
# 原始碼所在的專案資料夾（打包後沒有意義，只在開發時用）
SOURCE_DIR = Path(__file__).resolve().parent.parent


def _user_data_dir() -> Path:
    if sys.platform == 'win32':
        base = Path(os.environ.get('APPDATA') or Path.home() / 'AppData' / 'Roaming')
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library' / 'Application Support'
    else:
        base = Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local' / 'share')
    return base / APP_NAME


def _documents_dir() -> Path:
    if sys.platform == 'win32':
        try:  # 使用者可能把「文件」搬到別的磁碟
            import ctypes
            from ctypes import wintypes
            buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
            if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:
                return Path(buf.value)  # 5 = CSIDL_PERSONAL（文件）
        except Exception:  # noqa: BLE001
            pass
    docs = Path.home() / 'Documents'
    return docs if docs.is_dir() else Path.home()


DATA_DIR = _user_data_dir() if FROZEN else SOURCE_DIR
OUTPUT_DIR = (_documents_dir() / APP_NAME) if FROZEN else SOURCE_DIR / 'output'


def ui_file(name: str = 'index.html') -> Path:
    return RESOURCE_DIR / 'ui' / name
