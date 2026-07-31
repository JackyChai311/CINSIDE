# -*- mode: python ; coding: utf-8 -*-
import os
import sys
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# 收集所有需要的包
datas = []
binaries = []
hiddenimports = []

# 添加核心依赖
for pkg in ['uvicorn', 'fastapi', 'openpyxl', 'httpx', 'rapidfuzz', 'pydantic', 'markitdown', 'fitz', 'PIL']:
    try:
        ret = collect_all(pkg)
        datas += ret[0]
        binaries += ret[1]
        hiddenimports += ret[2]
    except:
        pass

# 额外需要的隐藏导入
hiddenimports += [
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'multipart',
    'PIL',
    'PIL._tkinter_finder',
    'fitz',
    'lxml',
    'pdfminer',
]

# 收集 app 包的所有子模块（config, routers, services, agents 等）
hiddenimports += collect_submodules('app')

a = Analysis(
    ['run.py'],
    pathex=[os.path.abspath('.')],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='cinside-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='../assets/app-icon.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='cinside-backend',
)
