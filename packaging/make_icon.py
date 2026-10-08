# -*- coding: utf-8 -*-
"""產生 App 圖示（跟介面左上角的標誌一樣）：藍紫漸層圓角方塊＋三條字幕線。
輸出 packaging/icon.png（1024px）、icon.ico（Windows）、icon.icns（macOS）。
用法：python packaging/make_icon.py"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent
S = 1024 * 4          # 先畫 4 倍大再縮小，邊緣才平滑


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def make() -> Image.Image:
    top, bottom = (10, 132, 255), (94, 92, 230)        # #0a84ff → #5e5ce6
    grad = Image.new('RGB', (S, S))
    px = grad.load()
    for y in range(S):
        for x in range(0, S, 8):
            c = lerp(top, bottom, (x * 0.35 + y * 0.65) / S)
            for k in range(8):
                px[x + k, y] = c
    # macOS 圖示慣例：方塊佔畫布約 80%，四周留白讓系統加陰影
    pad = round(S * 0.10)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((pad, pad, S - pad, S - pad), radius=round(S * 0.18), fill=255)
    icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(icon)
    box = S - 2 * pad
    w = round(box * 0.085)                               # 線寬
    for i, length in enumerate((0.58, 0.38, 0.25)):     # 對應 svg 的 14、9、6
        y = pad + round(box * (0.36 + i * 0.15))
        x0 = pad + round(box * 0.21)
        x1 = x0 + round(box * length)
        d.rounded_rectangle((x0, y - w // 2, x1, y + w // 2), radius=w // 2, fill=(255, 255, 255, 255))
    return icon.resize((1024, 1024), Image.LANCZOS)


if __name__ == '__main__':
    img = make()
    img.save(HERE / 'icon.png')
    img.save(HERE / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    img.save(HERE / 'icon.icns')   # macOS；先做好，打包機不必裝 Pillow
    print('saved', HERE / 'icon.png', HERE / 'icon.ico', HERE / 'icon.icns')
