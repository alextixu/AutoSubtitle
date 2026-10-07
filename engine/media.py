# -*- coding: utf-8 -*-
"""media — 用 PyAV（faster-whisper 已附帶）做兩件事，不需要 ffmpeg 執行檔：
1. waveform_peaks：解碼音訊 → 每桶 min/max 峰值，給前端 canvas 畫波形
2. detect_scenes：低解析度取樣畫面、算幀差 → 剪輯切點（波形區的藍點磁吸用）"""
from __future__ import annotations
import numpy as np


def waveform_peaks(path: str, buckets_per_sec: int = 50) -> dict:
    """回傳 {duration, rate, peaks:[[min,max],…]}，峰值正規化到 -1~1。"""
    import av
    peaks_min, peaks_max = [], []
    bucket, bucket_n = [], 0
    sr = None
    samples_per_bucket = None
    with av.open(path) as container:
        stream = next((s for s in container.streams if s.type == 'audio'), None)
        if stream is None:
            return {'duration': 0, 'rate': buckets_per_sec, 'peaks': []}
        resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
        sr = 16000
        samples_per_bucket = sr // buckets_per_sec
        for frame in container.decode(stream):
            for rf in resampler.resample(frame):
                arr = rf.to_ndarray().ravel().astype(np.float32) / 32768.0
                bucket.append(arr)
                bucket_n += len(arr)
                while bucket_n >= samples_per_bucket:
                    joined = np.concatenate(bucket)
                    chunk, rest = joined[:samples_per_bucket], joined[samples_per_bucket:]
                    peaks_min.append(round(float(chunk.min()), 3))
                    peaks_max.append(round(float(chunk.max()), 3))
                    bucket = [rest] if len(rest) else []
                    bucket_n = len(rest)
    if bucket_n:
        joined = np.concatenate(bucket)
        peaks_min.append(round(float(joined.min()), 3))
        peaks_max.append(round(float(joined.max()), 3))
    duration = len(peaks_min) / buckets_per_sec
    return {'duration': round(duration, 3), 'rate': buckets_per_sec,
            'peaks': [[a, b] for a, b in zip(peaks_min, peaks_max)]}


def detect_scenes(path: str, threshold: float = 0.08, sample_fps: float = 8.0) -> list[float]:
    """偵測剪輯切點：縮到 64px 灰階、每秒取樣 sample_fps 幀、
    幀差超過 threshold 就視為一個切點。回傳切點秒數列表。"""
    import av
    cuts = []
    prev = None
    last_t = -1.0
    with av.open(path) as container:
        stream = next((s for s in container.streams if s.type == 'video'), None)
        if stream is None:
            return []
        stream.thread_type = 'AUTO'
        min_gap = 1.0 / sample_fps
        for frame in container.decode(stream):
            t = float(frame.pts * stream.time_base) if frame.pts is not None else None
            if t is None or t - last_t < min_gap:
                continue
            last_t = t
            small = frame.reformat(width=64, height=36, format='gray')
            arr = small.to_ndarray().astype(np.float32) / 255.0
            if prev is not None:
                diff = float(np.abs(arr - prev).mean())
                if diff > threshold:
                    # 與上一個切點至少隔 0.25 秒，避免連續誤判
                    if not cuts or t - cuts[-1] > 0.25:
                        cuts.append(round(t, 3))
            prev = arr
    return cuts
