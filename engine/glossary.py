# -*- coding: utf-8 -*-
"""glossary — 詞庫：越用越準。
使用者修正字幕後，用 difflib 找出「改成了什麼」，自動把新寫法加入詞庫；
下次辨識時整包塞進 initial_prompt，Whisper 會偏向這些寫法。"""
from __future__ import annotations
import difflib
import json
from pathlib import Path


class Glossary:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.words: list[str] = []
        self.load()

    def load(self):
        if self.path.exists():
            try:
                self.words = json.loads(self.path.read_text(encoding='utf-8'))
            except Exception:
                self.words = []

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.words, ensure_ascii=False, indent=1),
                             encoding='utf-8')

    def add(self, word: str) -> bool:
        word = word.strip()
        if not word or word in self.words:
            return False
        self.words.append(word)
        self.save()
        return True

    def remove(self, word: str):
        if word in self.words:
            self.words.remove(word)
            self.save()

    PUNCT = '，。、！？；：（）「」 ,.!?;:()\'"\t\n'

    def learn_from_edit(self, old: str, new: str) -> list[str]:
        """比對修正前後文字，回傳「值得加入詞庫」的候選詞。
        單字修正（斷具→斷句）會往左右擴到詞邊界，抓出完整詞（斷句）。
        只回傳候選，讓 UI 跳提示由使用者確認。"""
        candidates = []
        sm = difflib.SequenceMatcher(None, old, new)
        for tag, _i1, _i2, j1, j2 in sm.get_opcodes():
            if tag not in ('replace', 'insert'):
                continue
            # 往左右各擴最多 2 個非標點字元，補足詞的上下文
            a, b = j1, j2
            grow = 0
            while a > 0 and grow < 2 and new[a-1] not in self.PUNCT:
                a -= 1
                grow += 1
            grow = 0
            while b < len(new) and grow < 2 and new[b] not in self.PUNCT:
                b += 1
                grow += 1
            frag = new[a:b].strip(self.PUNCT)
            if 2 <= len(frag) <= 8 and frag not in self.words and frag not in candidates:
                candidates.append(frag)
        return candidates
