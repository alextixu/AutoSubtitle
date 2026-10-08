# -*- coding: utf-8 -*-
"""transcriber — faster-whisper 聽打、斷句、詞級時間戳。

長影片（超過 CHUNK_SEC）會自動分段辨識：faster-whisper 會把整段音訊一次做
FFT，一小時的影片需要一整塊 GB 級的連續記憶體，容易失敗。分段點選在音量
最低處，避免把句子切斷。
"""
from __future__ import annotations

import os
from pathlib import Path

# MKL 預設啟用「快速記憶體管理器」，會先向系統要一大塊記憶體池。在認可額度
# （commit limit＝實體記憶體＋分頁檔）吃緊的機器上，這會讓模型連載入都失敗，
# 即使實體記憶體還很空。關掉它換取可載入性，效能影響很小。
# 必須在 import ctranslate2/faster_whisper 之前設定才有效（本檔延後 import）。
os.environ.setdefault('MKL_DISABLE_FAST_MM', '1')

MAX_CHARS_CJK = 16
MAX_CHARS_LATIN = 42
MAX_DURATION = 6.0
SAMPLE_RATE = 16000      # whisper 固定吃 16kHz mono
CHUNK_SEC = 240.0        # 超過此長度就分段辨識
CPU_THREADS = 4          # ctranslate2 每條執行緒都配一份工作緩衝區，開滿核心很吃記憶體

_model_cache: dict = {}


def _add_cuda_dll_dirs():
    """Windows：讓 ctranslate2 找得到 pip 裝的 NVIDIA 函式庫。
    `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` 會把 cublas64_12.dll、cudnn64_9.dll
    放在 site-packages/nvidia/*/bin，但這些資料夾不在 DLL 搜尋路徑裡，不加就會出現
    「Library cublas64_12.dll is not found」。"""
    if os.name != 'nt' or getattr(_add_cuda_dll_dirs, 'done', False):
        return
    _add_cuda_dll_dirs.done = True
    import site
    import sys
    roots = [Path(p) / 'nvidia' for p in [*site.getsitepackages(), site.getusersitepackages(),
                                          *sys.path] if p]
    seen = set()
    for root in roots:
        for d in root.glob('*/bin') if root.is_dir() else []:
            key = str(d.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            try:
                os.add_dll_directory(str(d))
            except OSError:
                continue
            os.environ['PATH'] = str(d) + os.pathsep + os.environ.get('PATH', '')


def is_cjk(text: str) -> bool:
    cjk = sum(1 for ch in text if '一' <= ch <= '鿿' or '぀' <= ch <= 'ヿ' or '가' <= ch <= '힯')
    return cjk > len(text.strip()) * 0.3


def clean_text(text: str) -> str:
    return text.strip().rstrip('，。、；：,.;: ')


def split_segment(words, max_chars: int):
    """依詞級時間戳把一段話切成適合字幕的短句：優先在標點切，過長/過久硬切。"""
    lines, cur, cur_len = [], [], 0
    BREAK_AFTER = '，。！？；：、,.!?;: '
    for w in words:
        cur.append(w)
        cur_len += len(w.word.strip())
        too_long = cur_len >= max_chars
        at_punct = w.word.strip()[-1:] in BREAK_AFTER if w.word.strip() else False
        too_slow = cur and (w.end - cur[0].start) >= MAX_DURATION
        if (too_long or too_slow) or (at_punct and cur_len >= max_chars * 0.6):
            lines.append(cur)
            cur, cur_len = [], 0
    if cur:
        lines.append(cur)
    return lines


def _is_mem_error(e: BaseException) -> bool:
    """記憶體不足的錯誤在各層有不同名字：MemoryError、mkl_malloc、bad_alloc…"""
    if isinstance(e, MemoryError):
        return True
    s = str(e).lower()
    return 'alloc' in s or 'out of memory' in s or 'memory' in s


def get_model(size: str = 'small', device: str = 'cpu',
              cpu_threads: int = CPU_THREADS):
    """載入模型。記憶體不足時（Windows 認可額度用盡最常見）逐步減少執行緒重試，
    因為 ctranslate2/MKL 是按執行緒數配置工作緩衝區的。"""
    key = (size, device, cpu_threads)
    if key in _model_cache:
        return _model_cache[key]
    if device != 'cpu':
        _add_cuda_dll_dirs()
    from faster_whisper import WhisperModel
    compute = 'int8' if device == 'cpu' else 'auto'
    attempts = [cpu_threads, 2, 1] if device == 'cpu' else [0]
    last_err = None
    for n in attempts:
        try:
            kw = {'cpu_threads': n} if (device == 'cpu' and n) else {}
            model = WhisperModel(size, device=device, compute_type=compute, **kw)
            _model_cache[key] = model
            return model
        except (RuntimeError, MemoryError) as e:
            if not _is_mem_error(e):
                raise
            last_err = e
    raise MemoryError(
        f'記憶體不足，無法載入 {size} 模型。可試：改用較小模型（--model base）、'
        f'關閉佔記憶體的程式，或調大 Windows 分頁檔。原始錯誤：{last_err}')


MODEL_LADDER = ['large-v3', 'medium', 'small', 'base', 'tiny']


def load_model_with_fallback(size: str, device: str = 'cpu',
                             cpu_threads: int = CPU_THREADS, on_fallback=None):
    """載不動就退而求其次，用能跑的最大模型，而不是整個失敗。
    回傳 (model, 實際使用的模型名稱)。"""
    ladder = MODEL_LADDER[MODEL_LADDER.index(size):] if size in MODEL_LADDER else [size]
    last_err = None
    for s in ladder:
        try:
            return get_model(s, device, cpu_threads), s
        except MemoryError as e:
            last_err = e
            if on_fallback:
                on_fallback(s)
    raise last_err or MemoryError('無法載入任何模型')


def clean_cues(cues: list[dict]) -> list[dict]:
    """濾掉 Whisper 在靜音處的幻覺輸出。
    靜音段常會憑空生出重複前文的句子，特徵是：零長度、語速快到不可能、
    或與前一句一字不差。這三種都刪掉。"""
    out: list[dict] = []
    for c in cues:
        dur = c['end'] - c['start']
        text = c['text'].strip()
        if not text or dur <= 0.05:
            continue
        # 語速合理性：中文正常 4~6 字/秒，英文約 2~3 詞/秒
        if is_cjk(text):
            if len(text) / dur > 12:
                continue
        elif len(text.split()) / dur > 6:
            continue
        if out and out[-1]['text'] == text and c['start'] - out[-1]['end'] < 1.0:
            continue
        out.append(c)
    return out


def decode_audio(path: str, sr: int = SAMPLE_RATE,
                 start: float = 0.0, end: float | None = None):
    """用 PyAV 把任何影音檔解成 16kHz mono float32（-1~1），只讀音訊軌。
    start/end（秒）只取一段：先 seek 到 start 前最近的封包，不必從頭讀整個檔案，
    再依第一個解出的音框時間把多解的部分精準裁掉。"""
    import av
    import numpy as np
    parts = []
    first_t = None
    with av.open(path) as container:
        stream = next((s for s in container.streams if s.type == 'audio'), None)
        if stream is None:
            raise ValueError('這個檔案沒有音訊軌')
        stream.thread_type = 'AUTO'
        if start > 0:
            container.seek(int(start / stream.time_base), stream=stream, backward=True)
        resampler = av.AudioResampler(format='s16', layout='mono', rate=sr)
        for frame in container.decode(stream):
            t = float(frame.pts * stream.time_base) if frame.pts is not None else None
            if first_t is None:
                first_t = t if t is not None else 0.0
            if end is not None and t is not None and t > end:
                break
            for rf in resampler.resample(frame):
                parts.append(rf.to_ndarray().ravel())
        for rf in resampler.resample(None):     # flush
            parts.append(rf.to_ndarray().ravel())
    if not parts:
        return np.zeros(0, dtype=np.float32)
    audio = np.concatenate(parts).astype(np.float32) / 32768.0
    if start > 0:
        audio = audio[int(max(0.0, start - (first_t or 0.0)) * sr):]
    if end is not None:
        audio = audio[:int(max(0.0, end - start) * sr)]
    return audio


def _quiet_point(audio, target_sec: float, search: float = 6.0,
                 sr: int = SAMPLE_RATE) -> float:
    """在 target 秒附近找音量最低處當分段點，避免把一句話切成兩半。"""
    import numpy as np
    lo = max(0, int((target_sec - search) * sr))
    hi = min(len(audio), int((target_sec + search) * sr))
    step = int(0.1 * sr)
    if hi - lo < step * 2:
        return target_sec
    best_i, best_e = lo, float('inf')
    for i in range(lo, hi - step, step):
        e = float(np.abs(audio[i:i + step]).mean())
        if e < best_e:
            best_e, best_i = e, i
    return (best_i + step // 2) / sr


def transcribe(path: str, model_size: str = 'small', device: str = 'cpu',
               lang: str | None = None, glossary_words: list[str] | None = None,
               to_taiwan: bool = True, progress=None,
               chunk_sec: float = CHUNK_SEC,
               cpu_threads: int = CPU_THREADS,
               start_sec: float = 0.0, end_sec: float | None = None) -> dict:
    """辨識檔案 → {language, cues:[{start,end,text,words:[[字,起,迄],…]}]}
    progress: 可選 callback(比例 0~1)。長檔案自動分段，記憶體用量固定。
    start_sec/end_sec 只辨識其中一段，輸出時間仍是原檔案的時間。
    記憶體不足時自動改用能跑的最大模型（載入階段與推論階段都會降級），
    實際使用的模型記在回傳的 model_used。"""
    base_prompt = '、'.join(glossary_words) + '。' if glossary_words else ''

    audio = decode_audio(path, start=start_sec, end=end_sec)
    total = max(len(audio) / SAMPLE_RATE, 0.001)

    # 切出分段邊界（都落在安靜處）
    bounds = [0.0]
    if total > chunk_sec * 1.2:
        t = chunk_sec
        while t < total - chunk_sec * 0.3:
            bounds.append(_quiet_point(audio, t))
            t += chunk_sec
    bounds.append(total)

    def _run(model, used: str) -> dict:
        cc = None
        language, lang_prob = lang, 1.0
        cues: list[dict] = []
        prev_tail = ''
        for k in range(len(bounds) - 1):
            a, b = bounds[k], bounds[k + 1]
            clip = audio[int(a * SAMPLE_RATE):int(b * SAMPLE_RATE)]
            if len(clip) < SAMPLE_RATE * 0.1:
                continue
            # 帶上一段結尾當上下文，讓跨段語意連貫
            prompt = (base_prompt + prev_tail).strip() or None
            segments, info = model.transcribe(
                clip, language=language, word_timestamps=True,
                initial_prompt=prompt, vad_filter=True,
            )
            if language is None:
                language, lang_prob = info.language, info.language_probability
            if cc is None and to_taiwan and language == 'zh':
                from opencc import OpenCC
                cc = OpenCC('s2twp')

            for seg in segments:
                if progress:
                    progress(min((a + float(seg.end)) / total, 1.0))
                if not seg.words:
                    text = clean_text(seg.text)
                    if text:
                        cues.append({'start': round(a + float(seg.start), 3),
                                     'end': round(a + float(seg.end), 3),
                                     'text': cc.convert(text) if cc else text, 'words': []})
                    continue
                max_chars = MAX_CHARS_CJK if is_cjk(seg.text) else MAX_CHARS_LATIN
                for line in split_segment(seg.words, max_chars):
                    text = clean_text(''.join(w.word for w in line))
                    if not text:
                        continue
                    if cc:
                        text = cc.convert(text)
                    words = [[w.word.strip(), round(a + float(w.start), 3),
                              round(a + float(w.end), 3)]
                             for w in line if w.word.strip()]
                    cues.append({'start': round(a + float(line[0].start), 3),
                                 'end': round(a + float(line[-1].end), 3),
                                 'text': text, 'words': words})
            prev_tail = ''.join(c['text'] for c in cues[-4:])[-120:]

        if progress:
            progress(1.0)
        return {'language': language,
                'language_probability': round(float(lang_prob), 3),
                'duration': round(total, 3),
                'model_used': used,
                'cues': clean_cues(cues)}

    # 模型階梯：載入或推論任一階段撞到記憶體，就退一級重跑，而不是整個失敗
    ladder = (MODEL_LADDER[MODEL_LADDER.index(model_size):]
              if model_size in MODEL_LADDER else [model_size])
    last_err: Exception | None = None
    for size in ladder:
        try:
            model = get_model(size, device, cpu_threads)
        except MemoryError as e:
            last_err = e
            print(f'[!] 記憶體不足：{size} 模型載不進來，改用小一號的模型', flush=True)
            continue
        try:
            result = _run(model, size)
            if start_sec:
                # 把片段內的相對時間平移回原檔案時間
                for c in result['cues']:
                    c['start'] = round(c['start'] + start_sec, 3)
                    c['end'] = round(c['end'] + start_sec, 3)
                    c['words'] = [[w, round(ws + start_sec, 3), round(we + start_sec, 3)]
                                  for w, ws, we in c['words']]
            result['offset'] = start_sec
            return result
        except (RuntimeError, MemoryError) as e:
            if not _is_mem_error(e):
                raise
            last_err = e
            _model_cache.pop((size, device, cpu_threads), None)   # 放掉這顆模型再重試
            print(f'[!] 記憶體不足：{size} 模型跑到一半失敗，改用小一號的模型重跑',
                  flush=True)
    raise last_err or MemoryError('記憶體不足，無法完成辨識')
