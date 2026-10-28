# -*- coding: utf-8 -*-
"""subimport — 讀入既有的 SRT／VTT 字幕檔，轉成專案用的 cues。

可以拿別的軟體做好的字幕來編輯、改樣式、燒錄，不必重新辨識。
"""
from __future__ import annotations

import re
from pathlib import Path

_TIME = re.compile(r'(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})')
_ARROW = re.compile(r'(\S+)\s*-->\s*(\S+)')
_TAGS = re.compile(r'<[^>]+>|\{\\[^}]*\}')     # <i>、<c.xxx>、{\an8} 這類標記


def _sec(s: str) -> float:
    m = _TIME.search(s)
    if not m:
        raise ValueError(f'看不懂的時間：{s}')
    h, mi, se, ms = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(se) + int(ms.ljust(3, '0')) / 1000


def parse(text: str) -> list[dict]:
    """解析 SRT 或 VTT 文字；回傳 [{start, end, text, words: []}]，依時間排序"""
    text = text.replace('\r\n', '\n').replace('\r', '\n').lstrip('﻿')
    cues: list[dict] = []
    for block in re.split(r'\n\s*\n', text):
        lines = [ln for ln in block.split('\n') if ln.strip()]
        idx = next((k for k, ln in enumerate(lines) if '-->' in ln), None)
        if idx is None:
            continue                                # WEBVTT 標頭、NOTE、STYLE 區塊
        m = _ARROW.search(lines[idx])
        if not m:
            continue
        try:
            start, end = _sec(m.group(1)), _sec(m.group(2))
        except ValueError:
            continue
        body = '\n'.join(_TAGS.sub('', ln).strip() for ln in lines[idx + 1:]).strip()
        if not body:
            continue
        if end <= start:
            end = start + 0.5
        cues.append({'start': round(start, 3), 'end': round(end, 3), 'text': body, 'words': []})
    cues.sort(key=lambda c: (c['start'], c['end']))
    return cues


def load(path: str) -> list[dict]:
    raw = Path(path).read_bytes()
    for enc in ('utf-8-sig', 'utf-16', 'cp950', 'gb18030', 'latin-1'):
        try:
            return parse(raw.decode(enc))
        except UnicodeDecodeError:
            continue
    raise ValueError('無法判斷字幕檔的文字編碼')
