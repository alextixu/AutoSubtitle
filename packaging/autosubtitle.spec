# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包設定：Windows 產生 AutoSubtitle 資料夾（含 AutoSubtitle.exe），
macOS 產生 AutoSubtitle.app。

    pip install pyinstaller
    pyinstaller packaging/autosubtitle.spec --noconfirm

版本號由環境變數 APP_VERSION 指定（預設 1.0.0）。
AS_GPU=1 時（只限 Windows）把 pip 安裝的 NVIDIA cuBLAS／cuDNN 一起打包成 GPU 版：
    pip install nvidia-cublas-cu12 nvidia-cudnn-cu12"""
import os
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))
VERSION = os.environ.get('APP_VERSION', '1.0.0').lstrip('v')
IS_MAC = sys.platform == 'darwin'
IS_WIN = sys.platform == 'win32'
GPU = IS_WIN and os.environ.get('AS_GPU') == '1'

datas = [(os.path.join(ROOT, 'ui'), 'ui')]
datas += collect_data_files('faster_whisper')        # Silero VAD 模型（onnx）
datas += collect_data_files('opencc')                # 簡繁轉換字典
binaries = collect_dynamic_libs('ctranslate2') + collect_dynamic_libs('onnxruntime')
if GPU:
    # 只帶 Whisper 推論需要的 DLL；放在 _internal/nvidia/<套件>/bin，engine 會自動加進搜尋路徑
    import glob
    import nvidia
    nv_root = list(nvidia.__path__)[0]
    # 實測 Whisper 用不到：cuDNN 的 RNN（adv）、執行期編譯引擎（連帶不需要 nvrtc）、nvblas。
    # 拿掉後 GPU 版從 2.3 GB 降到約 1.8 GB，辨識結果相同。
    skip = {'cudnn_adv64_9.dll', 'cudnn_engines_runtime_compiled64_9.dll', 'nvblas64_12.dll'}
    for pkg in ('cublas', 'cudnn'):
        for dll in glob.glob(os.path.join(nv_root, pkg, 'bin', '*.dll')):
            if os.path.basename(dll) not in skip:
                binaries.append((dll, f'nvidia/{pkg}/bin'))
    if not any('cublas64_' in b[0] for b in binaries):
        raise SystemExit('AS_GPU=1 但找不到 cuBLAS：先 pip install nvidia-cublas-cu12 nvidia-cudnn-cu12')
hiddenimports = collect_submodules('engine') + ['app', 'opencc']
if IS_MAC:
    hiddenimports += ['webview.platforms.cocoa']
elif IS_WIN:
    hiddenimports += ['webview.platforms.edgechromium', 'webview.platforms.winforms']

# 開發環境裡有、但這個程式用不到的大型套件，不要被連帶打包
excludes = ['torch', 'torchvision', 'torchaudio', 'tensorflow', 'keras', 'jax', 'matplotlib',
            'pandas', 'scipy', 'sklearn', 'IPython', 'jupyter', 'notebook', 'PyQt5', 'PyQt6',
            'PySide2', 'PySide6', 'cv2'] + ([] if GPU else ['nvidia'])

a = Analysis(
    [os.path.join(ROOT, 'gui.py')],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)

icon = os.path.join(SPECPATH, 'icon.icns' if IS_MAC else 'icon.ico')
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='AutoSubtitle',
    console=False,                # 視窗程式，不跳主控台
    upx=False,
    icon=icon,
    argv_emulation=False,
    target_arch=None,
)
coll = COLLECT(exe, a.binaries, a.datas, name='AutoSubtitle', upx=False)

if IS_MAC:
    app = BUNDLE(
        coll,
        name='AutoSubtitle.app',
        icon=icon,
        bundle_identifier='io.github.alextixu.autosubtitle',
        version=VERSION,
        info_plist={
            'CFBundleDisplayName': 'AutoSubtitle 字幕工房',
            'CFBundleName': 'AutoSubtitle',
            'CFBundleShortVersionString': VERSION,
            'CFBundleVersion': VERSION,
            'LSMinimumSystemVersion': '11.0',
            'NSHighResolutionCapable': True,
            'NSRequiresAquaSystemAppearance': False,   # 跟著系統深色模式
            'LSApplicationCategoryType': 'public.app-category.video',
        },
    )
