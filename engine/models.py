# -*- coding: utf-8 -*-
"""models — 語音模型檔管理：查狀態、下載（真實進度、可取消、可續傳）、刪除。

為什麼不用 faster-whisper 內建的下載：它把 huggingface_hub 的進度條關掉了
（utils.download_model 傳 tqdm_class=disabled_tqdm），下載幾百 MB 到 3 GB 時介面
完全看不到進度，也無法取消。這裡自己逐檔串流下載：

  模型資料夾/<模型 id>/config.json、model.bin、tokenizer.json、vocabulary.*
  下載中的檔案先寫成 <檔名>.part，中斷後可從斷點續傳；全部完成才寫 .complete。

WhisperModel 可以直接吃這個資料夾路徑，所以不需要 Hugging Face 的快取結構。
以前已經下載到 Hugging Face 預設快取（~/.cache/huggingface/hub）的模型也會被找到並沿用，
不會重複下載。
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path

from engine.paths import MODELS_DIR

# 檔案清單與大小取自 Hugging Face（2026-10）；實際下載時以伺服器回報的大小為準。
CATALOG = [
    {'id': 'tiny', 'label': '極速', 'repo': 'Systran/faster-whisper-tiny', 'bytes': 78_200_000,
     'desc': '最快、準確度最低，適合先試試看'},
    {'id': 'base', 'label': '快速', 'repo': 'Systran/faster-whisper-base', 'bytes': 147_900_000,
     'desc': '速度快，適合收音清楚的錄音'},
    {'id': 'small', 'label': '標準', 'repo': 'Systran/faster-whisper-small', 'bytes': 486_200_000,
     'desc': '速度與準確度平衡，一般電腦推薦'},
    {'id': 'medium', 'label': '精準', 'repo': 'Systran/faster-whisper-medium', 'bytes': 1_530_600_000,
     'desc': '更準，用 CPU 會比較慢'},
    {'id': 'large-v3-turbo', 'label': '高品質', 'repo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
     'bytes': 1_621_700_000, 'desc': '接近最高等級的準確度、速度接近「精準」，有顯示卡時推薦'},
    {'id': 'large-v3', 'label': '最高', 'repo': 'Systran/faster-whisper-large-v3', 'bytes': 3_090_800_000,
     'desc': '最準也最慢，建議有顯示卡再用'},
]
_BY_ID = {m['id']: m for m in CATALOG}
# faster-whisper 只需要這幾個檔（與 utils.download_model 的 allow_patterns 相同）
_WANTED = ('config.json', 'preprocessor_config.json', 'model.bin', 'tokenizer.json',
           'vocabulary.txt', 'vocabulary.json')
_REQUIRED = ('config.json', 'model.bin', 'tokenizer.json')
CHUNK = 1 << 20


class DownloadCancelled(Exception):
    """使用者取消下載；已下載的部分保留成 .part，下次從斷點繼續"""


def info(model_id: str) -> dict:
    if model_id not in _BY_ID:
        raise ValueError(f'不認識的模型：{model_id}')
    return _BY_ID[model_id]


def root() -> Path:
    return Path(MODELS_DIR)


def _own_dir(model_id: str) -> Path:
    return root() / model_id


def _hf_cache_path(model_id: str) -> str | None:
    """舊版或從原始碼執行時，模型可能已在 Hugging Face 預設快取；有就沿用。"""
    try:
        from faster_whisper.utils import download_model
        p = download_model(model_id, local_files_only=True)
    except Exception:  # noqa: BLE001  # 沒有就是沒有，各種例外都算
        return None
    return p if p and all((Path(p) / f).exists() for f in _REQUIRED) else None


def local_path(model_id: str) -> str | None:
    """模型已在本機就回傳資料夾路徑，否則 None。"""
    d = _own_dir(model_id)
    if (d / '.complete').exists() and all((d / f).exists() for f in _REQUIRED):
        return str(d)
    return _hf_cache_path(model_id)


def _dir_size(p: Path) -> int:
    total = 0
    for f in p.rglob('*'):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            pass
    return total


def _hf_repo_dir(snapshot: str) -> Path | None:
    """…/models--Org--name/snapshots/<sha> → …/models--Org--name；不符合結構就回 None（刪除時的安全檢查）"""
    p = Path(snapshot)
    for parent in p.parents:
        if parent.name.startswith('models--'):
            return parent
    return None


# ---------- 下載狀態（模型管理頁與轉檔工作共用，同一個模型同時只下載一次） ----------

class _State:
    def __init__(self, model_id: str):
        self.model_id = model_id
        self.done = 0
        self.total = info(model_id)['bytes']
        self.speed = 0.0          # bytes/s（指數平滑）
        self.cancel = False
        self.error: str | None = None
        self.finished = threading.Event()


_lock = threading.Lock()
_active: dict[str, _State] = {}


def active() -> dict[str, dict]:
    """目前下載中的模型：{id: {done, total, speed}}"""
    with _lock:
        return {k: {'done': s.done, 'total': s.total, 'speed': round(s.speed)}
                for k, s in _active.items()}


def cancel(model_id: str) -> bool:
    with _lock:
        s = _active.get(model_id)
        if s:
            s.cancel = True
        return bool(s)


def status() -> list[dict]:
    """給介面的模型清單：名稱、大小、是否已下載、存在哪裡、下載進度。"""
    act = active()
    out = []
    for m in CATALOG:
        own = _own_dir(m['id'])
        path = local_path(m['id'])
        where = None
        if path:
            where = 'app' if Path(path) == own else 'hf-cache'
        partial = sum(f.stat().st_size for f in own.glob('*.part')) if own.is_dir() and not path else 0
        out.append({**{k: m[k] for k in ('id', 'label', 'desc', 'bytes')},
                    'downloaded': bool(path), 'where': where, 'path': path,
                    'size_on_disk': _dir_size(Path(path)) if path else 0,
                    'partial': partial, 'downloading': act.get(m['id'])})
    return out


def _endpoint() -> str:
    return os.environ.get('HF_ENDPOINT', 'https://huggingface.co').rstrip('/')


def _list_files(repo: str, client) -> list[tuple[str, int]]:
    """從 Hugging Face API 取得要下載的檔案與大小；只取 faster-whisper 需要的檔。"""
    r = client.get(f'{_endpoint()}/api/models/{repo}/tree/main', timeout=30)
    r.raise_for_status()
    files = [(e['path'], int(e.get('size') or 0)) for e in r.json()
             if e.get('type') == 'file' and e.get('path') in _WANTED]
    if not any(f == 'model.bin' for f, _ in files):
        raise RuntimeError(f'{repo} 上找不到 model.bin')
    return files


def _download_files(st: _State, should_cancel):
    import httpx
    m = info(st.model_id)
    dest = _own_dir(st.model_id)
    dest.mkdir(parents=True, exist_ok=True)
    (dest / '.complete').unlink(missing_ok=True)
    headers = {'User-Agent': 'AutoSubtitle'}
    with httpx.Client(follow_redirects=True, headers=headers, timeout=httpx.Timeout(30, read=60)) as client:
        files = _list_files(m['repo'], client)
        st.total = sum(size for _, size in files) or st.total
        # 已完成的檔案與 .part 先算進進度
        st.done = 0
        for name, size in files:
            f, part = dest / name, dest / (name + '.part')
            if f.exists() and (not size or f.stat().st_size == size):
                st.done += f.stat().st_size
            elif part.exists():
                st.done += part.stat().st_size
        last_t, last_done = time.time(), st.done
        for name, size in files:
            f, part = dest / name, dest / (name + '.part')
            if f.exists() and (not size or f.stat().st_size == size):
                continue
            have = part.stat().st_size if part.exists() else 0
            if size and have > size:          # 壞掉的殘檔
                part.unlink()
                st.done -= have
                have = 0
            req_headers = {'Range': f'bytes={have}-'} if have else {}
            url = f'{_endpoint()}/{m["repo"]}/resolve/main/{name}'
            with client.stream('GET', url, headers=req_headers) as r:
                if have and r.status_code == 200:   # 伺服器不支援續傳，從頭來
                    st.done -= have
                    have = 0
                    mode = 'wb'
                else:
                    r.raise_for_status()
                    mode = 'ab' if have else 'wb'
                with open(part, mode) as out:
                    for chunk in r.iter_bytes(CHUNK):
                        if st.cancel or (should_cancel and should_cancel()):
                            raise DownloadCancelled
                        out.write(chunk)
                        st.done += len(chunk)
                        now = time.time()
                        if now - last_t >= 0.5:
                            inst = (st.done - last_done) / (now - last_t)
                            st.speed = inst if st.speed == 0 else st.speed * 0.7 + inst * 0.3
                            last_t, last_done = now, st.done
            if size and part.stat().st_size != size:
                raise RuntimeError(f'{name} 下載不完整（{part.stat().st_size}/{size} bytes）')
            os.replace(part, f)
    (dest / '.complete').write_text(json.dumps({'repo': m['repo'], 'files': files,
                                                'at': time.strftime('%Y-%m-%dT%H:%M:%S')}),
                                    encoding='utf-8')


def download(model_id: str, progress=None, should_cancel=None) -> str:
    """下載模型（已在本機就直接回傳路徑）。

    progress(done_bytes, total_bytes, speed) 會在下載期間定期呼叫；它可以拋例外來中止。
    should_cancel() 回傳 True 也會中止（拋 DownloadCancelled，保留 .part 供續傳）。
    同一個模型若已有別的地方在下載（例如模型管理頁），這裡會等它完成並轉播進度。"""
    p = local_path(model_id)
    if p:
        return p
    with _lock:
        st = _active.get(model_id)
        owner = st is None
        if owner:
            st = _active[model_id] = _State(model_id)
    if not owner:      # 別人在下載：等它完成，期間轉播進度
        while not st.finished.wait(0.25):
            if should_cancel and should_cancel():
                raise DownloadCancelled
            if progress:
                progress(st.done, st.total, st.speed)
        if st.error:
            raise RuntimeError(st.error)
        p = local_path(model_id)
        if not p:
            raise DownloadCancelled
        return p

    stop = threading.Event()

    def reporter():
        while not stop.wait(0.25):
            if progress:
                try:
                    progress(st.done, st.total, st.speed)
                except Exception:  # noqa: BLE001  # 由下載迴圈的 should_cancel 處理
                    st.cancel = True
    t = threading.Thread(target=reporter, daemon=True)
    t.start()
    try:
        _download_files(st, should_cancel)
        if progress:
            progress(st.total, st.total, st.speed)
        return str(_own_dir(model_id))
    except DownloadCancelled:
        raise
    except Exception as e:  # noqa: BLE001
        st.error = friendly_error(e)
        raise RuntimeError(st.error) from e
    finally:
        stop.set()
        with _lock:
            _active.pop(model_id, None)
        st.finished.set()


def friendly_error(e: BaseException) -> str:
    """把網路例外翻成人話"""
    name = type(e).__name__
    text = str(e)
    if name in ('ConnectError', 'ConnectTimeout') or 'getaddrinfo' in text or 'Name or service' in text:
        return '連不上 huggingface.co，請確認網路連線後再試（已下載的部分會保留）'
    if name in ('ReadTimeout', 'RemoteProtocolError', 'ReadError'):
        return '下載中斷，請再試一次（會從中斷處繼續）'
    if name == 'HTTPStatusError':
        return f'伺服器回應錯誤：{text[:120]}'
    if isinstance(e, OSError) and getattr(e, 'errno', None) == 28:
        return '磁碟空間不足，請清出空間後再試'
    return f'{name}: {text[:200]}'


def delete(model_id: str) -> int:
    """刪除模型，回傳釋放的位元組數。只刪這個模型自己的資料夾。"""
    info(model_id)
    if model_id in active():
        raise RuntimeError('這個模型正在下載，請先取消')
    freed = 0
    own = _own_dir(model_id)
    if own.is_dir():
        freed += _dir_size(own)
        shutil.rmtree(own, ignore_errors=True)
    hf = _hf_cache_path(model_id)
    if hf:
        repo_dir = _hf_repo_dir(hf)
        if repo_dir and repo_dir.is_dir():
            freed += _dir_size(repo_dir)
            shutil.rmtree(repo_dir, ignore_errors=True)
    return freed
