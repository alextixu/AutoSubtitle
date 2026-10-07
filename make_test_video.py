# -*- coding: utf-8 -*-
"""make_test_video.py — 產生測試 mp4：
彩色畫面每 4 秒切換一次（給切點偵測驗證）、配上 test_audio.wav 的聲音。"""
import numpy as np
import av

W, H, FPS = 640, 360, 24
COLORS = [(200, 60, 60), (60, 180, 90), (60, 90, 200), (220, 200, 80)]
CUT_EVERY = 4.0  # 每 4 秒切換畫面 → 預期切點在 4s, 8s, 12s

with av.open('test_audio.wav') as ain:
    astream = next(s for s in ain.streams if s.type == 'audio')
    duration = float(astream.duration * astream.time_base)
    aframes = [f for f in ain.decode(astream)]

out = av.open('test_video.mp4', 'w')
v = out.add_stream('h264', rate=FPS)
v.width, v.height, v.pix_fmt = W, H, 'yuv420p'
a = out.add_stream('aac', rate=44100)

resampler = av.AudioResampler(format='fltp', layout='stereo', rate=44100)

n_frames = int(duration * FPS) + FPS
for i in range(n_frames):
    t = i / FPS
    color = COLORS[int(t // CUT_EVERY) % len(COLORS)]
    img = np.zeros((H, W, 3), dtype=np.uint8)
    img[:, :] = color
    # 加一個移動方塊，讓畫面不是完全靜止
    x = int((t * 60) % (W - 60))
    img[150:210, x:x+60] = (255, 255, 255)
    frame = av.VideoFrame.from_ndarray(img, format='rgb24')
    for pkt in v.encode(frame):
        out.mux(pkt)
for pkt in v.encode():
    out.mux(pkt)

for f in aframes:
    for rf in resampler.resample(f):
        for pkt in a.encode(rf):
            out.mux(pkt)
for pkt in a.encode():
    out.mux(pkt)
out.close()
print(f'test_video.mp4 產生完成（{duration:.1f}s 音訊，預期切點：4s/8s/12s）')
