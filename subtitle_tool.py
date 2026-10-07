#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
subtitle_tool.py — 指令版自動上字幕（桌面版請用 python app.py）

功能與 engine/ 共用同一套核心：聽打、斷句、對時間、詞庫、台灣用語校正、
長影片自動分段、匯出 SRT/VTT/TXT/ASS、ffmpeg 燒錄。

用法：
  python subtitle_tool.py 影片.mp4
  python subtitle_tool.py 影片.mp4 --model small --formats srt,vtt,txt
  python subtitle_tool.py 影片.mp4 --glossary 詞庫.txt --burn

影片留在你的電腦，辨識全程離線（第一次會下載一次模型檔）。
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from engine import exporter, transcriber  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="本機影片自動上字幕（開源、離線）")
    ap.add_argument('input', help='影片或音訊檔（mp4/mov/mkv/mp3/wav/m4a…）')
    ap.add_argument('--model', default='small',
                    help='模型大小：tiny/base/small/medium/large-v3（預設 small）')
    ap.add_argument('--lang', default=None, help='語言代碼（zh/en/ja/…，不給則自動偵測）')
    ap.add_argument('--formats', default='srt,txt',
                    help='輸出格式，逗號分隔：srt,vtt,txt,ass')
    ap.add_argument('--glossary', default=None,
                    help='詞庫檔：一行一個專有名詞，提高辨識正確率')
    ap.add_argument('--device', default='cpu', choices=['cpu', 'cuda', 'auto'],
                    help='運算裝置（預設 cpu；有 NVIDIA GPU + CUDA 環境可用 cuda）')
    ap.add_argument('--no-tw', action='store_true', help='關閉「轉台灣繁體與用語」')
    ap.add_argument('--burn', action='store_true', help='用 ffmpeg 把字幕燒進影片')
    ap.add_argument('--timestamps', action='store_true',
                    help='逐字稿加上 [mm:ss] 時間標記')
    ap.add_argument('--outdir', default=None, help='輸出資料夾（預設與輸入檔同層）')
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        sys.exit(f"找不到檔案：{src}")
    outdir = Path(args.outdir) if args.outdir else src.parent
    outdir.mkdir(parents=True, exist_ok=True)

    words = None
    if args.glossary:
        words = [w.strip() for w in Path(args.glossary).read_text(encoding='utf-8').splitlines()
                 if w.strip()]
        print(f"[*] 詞庫載入 {len(words)} 個詞")

    print(f"[*] 辨識 {src.name}（模型 {args.model}，第一次會下載模型檔）…")
    t0 = time.time()
    last = [0.0]

    def prog(p):
        now = time.time()
        if now - last[0] > 10:
            last[0] = now
            print(f"    進度 {p*100:.0f}%（已花 {now-t0:.0f}s）", flush=True)

    r = transcriber.transcribe(
        str(src), model_size=args.model, device=args.device, lang=args.lang,
        glossary_words=words, to_taiwan=not args.no_tw, progress=prog)
    cues = r['cues']
    print(f"[*] 完成：語言={r['language']}（信心 {r['language_probability']:.0%}），"
          f"{len(cues)} 條字幕，耗時 {time.time()-t0:.0f}s")

    stem = src.stem
    formats = [f.strip().lower() for f in args.formats.split(',')]
    if args.burn and 'srt' not in formats:
        formats.append('srt')

    for fmt in formats:
        if fmt not in ('srt', 'vtt', 'txt', 'ass'):
            print(f"[!] 略過不支援的格式：{fmt}")
            continue
        out = outdir / f"{stem}.{fmt}"
        if fmt == 'txt' and args.timestamps:
            lines = []
            for c in cues:
                m, s = divmod(int(c['start']), 60)
                lines.append(f"[{m:02d}:{s:02d}] {c['text']}")
            out.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        else:
            exporter.export_file(cues, fmt, str(out))
        print(f"[+] {out}")

    if args.burn:
        ok, msg = exporter.burn_video(str(src), cues, str(outdir / f"{stem}_subtitled.mp4"))
        print(f"[+] 成品影片：{msg}" if ok else f"[!] 燒錄失敗：{msg}")

    print("[✓] 完成")


if __name__ == '__main__':
    main()
