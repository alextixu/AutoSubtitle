# -*- coding: utf-8 -*-
"""exporter — SRT / VTT / TXT / ASS 匯出與 ffmpeg 燒錄。
ASS 支援樣式（字型、顏色、外框、位置）與卡拉OK逐字標籤（\\k），
Premiere / Final Cut / DaVinci / 剪映都吃 SRT；要帶樣式燒錄就用 ASS。"""
from __future__ import annotations
import shutil
import subprocess
from pathlib import Path


def fmt_time(sec: float, vtt: bool = False) -> str:
    h, rem = divmod(int(sec), 3600)
    m, s = divmod(rem, 60)
    ms = int(round((sec - int(sec)) * 1000))
    sep = '.' if vtt else ','
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def fmt_ass_time(sec: float) -> str:
    h, rem = divmod(int(sec), 3600)
    m, s = divmod(rem, 60)
    cs = int(round((sec - int(sec)) * 100))
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def to_srt(cues) -> str:
    out = []
    for i, c in enumerate(cues, 1):
        out.append(f"{i}\n{fmt_time(c['start'])} --> {fmt_time(c['end'])}\n{c['text']}\n")
    return '\n'.join(out)


def to_vtt(cues) -> str:
    out = ['WEBVTT\n']
    for c in cues:
        out.append(f"{fmt_time(c['start'], vtt=True)} --> {fmt_time(c['end'], vtt=True)}\n{c['text']}\n")
    return '\n'.join(out)


def to_txt(cues) -> str:
    return '\n'.join(c['text'] for c in cues) + '\n'


def _ass_color(hexcolor: str, alpha: int = 0) -> str:
    """#RRGGBB → ASS 的 &HAABBGGRR"""
    hexcolor = hexcolor.lstrip('#')
    r, g, b = hexcolor[0:2], hexcolor[2:4], hexcolor[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def to_ass(cues, style: dict | None = None, play_w: int = 1920, play_h: int = 1080) -> str:
    """帶樣式的 ASS。style 鍵：font,size,color,outline_color,outline,pos_y(0~1),karaoke(bool)"""
    st = {'font': 'Noto Sans TC', 'size': 64, 'color': '#FFFFFF',
          'outline_color': '#000000', 'outline': 3, 'pos_y': 0.86,
          'karaoke': False, 'karaoke_color': '#39FF14'}
    st.update(style or {})
    margin_v = int(play_h * (1 - float(st['pos_y'])))
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {play_w}
PlayResY: {play_h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{st['font']},{st['size']},{_ass_color(st['color'])},{_ass_color(st['karaoke_color'])},{_ass_color(st['outline_color'])},&H64000000,0,0,0,0,100,100,0,0,1,{st['outline']},0,2,60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for c in cues:
        if st.get('karaoke') and c.get('words'):
            # \k 單位是 1/100 秒；逐字亮起（卡拉OK）
            parts, t = [], c['start']
            for w, ws, we in c['words']:
                gap = max(0, ws - t)
                if gap > 0.01:
                    parts.append(f"{{\\k{int(gap*100)}}}")
                parts.append(f"{{\\k{max(1, int((we-ws)*100))}}}{w}")
                t = we
            text = ''.join(parts)
        else:
            text = c['text']
        lines.append(f"Dialogue: 0,{fmt_ass_time(c['start'])},{fmt_ass_time(c['end'])},Default,,0,0,0,,{text}")
    return head + '\n'.join(lines) + '\n'


WRITERS = {'srt': to_srt, 'vtt': to_vtt, 'txt': to_txt}


def export_file(cues, fmt: str, out_path: str, style: dict | None = None) -> str:
    p = Path(out_path)
    if fmt == 'ass':
        content = to_ass(cues, style)
    else:
        content = WRITERS[fmt](cues)
    p.write_text(content, encoding='utf-8')
    return str(p)


def has_ffmpeg() -> bool:
    return shutil.which('ffmpeg') is not None


def burn_video(video: str, cues, out_path: str, style: dict | None = None) -> tuple[bool, str]:
    """把帶樣式的字幕燒進影片（成品影片）。需要 ffmpeg。"""
    if not has_ffmpeg():
        return False, '找不到 ffmpeg。安裝：winget install Gyan.FFmpeg'
    out = Path(out_path)
    ass_path = out.with_suffix('.burn.ass')
    ass_path.write_text(to_ass(cues, style), encoding='utf-8')
    ass_esc = str(ass_path).replace('\\', '/').replace(':', '\\:')
    cmd = ['ffmpeg', '-y', '-i', video, '-vf', f"ass='{ass_esc}'",
           '-c:a', 'copy', str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    ass_path.unlink(missing_ok=True)
    if r.returncode != 0:
        return False, (r.stderr or '')[-800:]
    return True, str(out)
