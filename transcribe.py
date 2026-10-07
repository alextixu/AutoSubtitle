#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
transcribe.py — 把影音檔轉成逐字稿，一次產出三種檔案：

  <名稱>_逐字稿.txt        純文字，適合閱讀、貼進文件
  <名稱>_逐字稿_含時間.txt  每行前面加 [mm:ss]，適合回頭找片段
  <名稱>.srt               字幕檔，可匯入剪輯軟體

用法：
  python transcribe.py 錄音.m4a
  python transcribe.py 影片.mp4 --model medium --outdir D:\\輸出
  python transcribe.py 錄音.m4a --glossary 詞庫.txt
  python transcribe.py 影片.mp4 --start 13:00            從 13 分鐘開始到結尾
  python transcribe.py 影片.mp4 --start 5:30 --end 20:00 只辨識其中一段
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from engine import exporter, transcriber  # noqa: E402


def parse_time(s: str) -> float:
    """'13:00' / '1:02:03' / '780' / '13m' → 秒"""
    s = s.strip().lower()
    if s.endswith('m'):
        return float(s[:-1]) * 60
    if s.endswith('s'):
        return float(s[:-1])
    secs = 0.0
    for part in s.split(':'):
        secs = secs * 60 + float(part)
    return secs


def fmt_clock(sec: float) -> str:
    h, rem = divmod(int(sec), 3600)
    m, s = divmod(rem, 60)
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m:02d}:{s:02d}'


def output_stem(src: Path, start: float = 0.0, end: float | None = None) -> str:
    """檔名沿用來源檔名；只取一段時標上範圍，避免蓋掉整支的結果"""
    stem = src.stem
    if start or end is not None:
        tag = fmt_clock(start).replace(':', '') + '-' + (
            fmt_clock(end).replace(':', '') if end is not None else 'end')
        stem = f'{stem}_{tag}'
    return stem


def write_outputs(cues: list[dict], outdir: Path, stem: str) -> list[Path]:
    """寫出 純文字／含時間／SRT 三個檔，回傳路徑列表"""
    plain = outdir / f'{stem}_逐字稿.txt'
    timed = outdir / f'{stem}_逐字稿_含時間.txt'
    srt = outdir / f'{stem}.srt'
    plain.write_text(exporter.to_txt(cues), encoding='utf-8')
    lines = [f'[{fmt_clock(c["start"])}] {c["text"]}' for c in cues]
    timed.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    srt.write_text(exporter.to_srt(cues), encoding='utf-8')
    return [plain, timed, srt]


def main():
    ap = argparse.ArgumentParser(description='影音檔 → 逐字稿（純文字／含時間／SRT）')
    ap.add_argument('input', help='影片或音訊檔')
    ap.add_argument('--model', default='small',
                    help='tiny/base/small/medium/large-v3（預設 small）')
    ap.add_argument('--lang', default=None, help='語言代碼，不給則自動偵測')
    ap.add_argument('--glossary', default=None, help='詞庫檔：一行一個專有名詞')
    ap.add_argument('--device', default='cpu', choices=['cpu', 'cuda', 'auto'])
    ap.add_argument('--no-tw', action='store_true', help='關閉台灣繁體用語轉換')
    ap.add_argument('--outdir', default=None,
                    help='輸出資料夾（預設 output/）')
    ap.add_argument('--start', default=None, help='從哪裡開始，如 13:00 或 780')
    ap.add_argument('--end', default=None, help='到哪裡結束，如 20:00（預設到結尾）')
    args = ap.parse_args()
    start = parse_time(args.start) if args.start else 0.0
    end = parse_time(args.end) if args.end else None
    if end is not None and end <= start:
        sys.exit('--end 必須晚於 --start')

    src = Path(args.input)
    if not src.exists():
        sys.exit(f'找不到檔案：{src}')
    outdir = Path(args.outdir) if args.outdir else Path(__file__).parent / 'output'
    outdir.mkdir(parents=True, exist_ok=True)

    words = None
    if args.glossary:
        words = [w.strip() for w in Path(args.glossary).read_text(encoding='utf-8').splitlines()
                 if w.strip()]
        print(f'[*] 詞庫載入 {len(words)} 個詞')

    span = ''
    if start or end is not None:
        span = f'，範圍 {fmt_clock(start)} ~ {fmt_clock(end) if end is not None else "結尾"}'
    print(f'[*] 辨識 {src.name}（模型 {args.model}{span}）…', flush=True)
    t0 = time.time()
    last = [0.0]

    def prog(p):
        now = time.time()
        if now - last[0] > 10:
            last[0] = now
            print(f'    進度 {p*100:.0f}%（已花 {now-t0:.0f}s）', flush=True)

    r = transcriber.transcribe(
        str(src), model_size=args.model, device=args.device, lang=args.lang,
        glossary_words=words, to_taiwan=not args.no_tw, progress=prog,
        start_sec=start, end_sec=end)
    cues = r['cues']
    used = r.get('model_used', args.model)
    note = '' if used == args.model else f'（實際使用 {used} 模型）'
    print(f'[*] 完成：語言={r["language"]}（信心 {r["language_probability"]:.0%}），'
          f'{len(cues)} 條，耗時 {time.time()-t0:.0f}s{note}', flush=True)

    files = write_outputs(cues, outdir, output_stem(src, start, end))
    print('[+] 輸出完成：')
    for f in files:
        print(f'    {f}  ({f.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
