# -*- coding: utf-8 -*-
"""projects — 本機專案管理（取代雲端專案，不需登入）。
每個專案一個資料夾：projects/<名稱>/project.json
儲存媒體路徑、字幕 cues（含詞級時間戳）、樣式、切點。"""
from __future__ import annotations
import json
import re
import time
from pathlib import Path


class ProjectStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _dir(self, name: str) -> Path:
        safe = re.sub(r'[\\/:*?"<>|]', '_', name).strip() or 'untitled'
        return self.root / safe

    def list(self) -> list[dict]:
        out = []
        for d in sorted(self.root.iterdir()):
            pj = d / 'project.json'
            if pj.exists():
                try:
                    data = json.loads(pj.read_text(encoding='utf-8'))
                    out.append({'name': d.name,
                                'media': data.get('media', ''),
                                'cue_count': len(data.get('cues', [])),
                                'updated': data.get('updated', 0)})
                except Exception:
                    pass
        out.sort(key=lambda x: -x['updated'])
        return out

    def create(self, name: str, media_path: str) -> dict:
        d = self._dir(name)
        d.mkdir(parents=True, exist_ok=True)
        data = {'media': media_path, 'cues': [], 'style': {}, 'scenes': [],
                'language': None, 'updated': time.time()}
        (d / 'project.json').write_text(json.dumps(data, ensure_ascii=False),
                                        encoding='utf-8')
        return data

    def load(self, name: str) -> dict | None:
        pj = self._dir(name) / 'project.json'
        if not pj.exists():
            return None
        return json.loads(pj.read_text(encoding='utf-8'))

    def save(self, name: str, data: dict):
        """先寫到暫存檔再換名：寫到一半當機也不會留下半個 project.json"""
        import os
        data['updated'] = time.time()
        d = self._dir(name)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / 'project.json.tmp'
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        os.replace(tmp, d / 'project.json')

    def snapshot(self, name: str, tag: str, keep: int = 8) -> Path | None:
        """把目前的 project.json 複製到 history/，例如重新辨識前；只保留最近 keep 份"""
        import shutil
        pj = self._dir(name) / 'project.json'
        if not pj.exists():
            return None
        hist = self._dir(name) / 'history'
        hist.mkdir(exist_ok=True)
        dst = hist / f'{time.strftime("%Y%m%d-%H%M%S")}-{tag}.json'
        shutil.copy2(pj, dst)
        old = sorted(hist.glob('*.json'))[:-keep]
        for f in old:
            try:
                f.unlink()
            except OSError:
                pass
        return dst

    def delete(self, name: str):
        import shutil
        d = self._dir(name)
        if (d / 'project.json').exists():
            shutil.rmtree(d)
