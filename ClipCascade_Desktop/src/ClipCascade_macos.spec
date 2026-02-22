# -*- mode: python ; coding: utf-8 -*-

import certifi

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[(certifi.where(), 'certifi')],
    hiddenimports=['tkinter'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='ClipCascade',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['../../logo/logo.icns'],
)
app = BUNDLE(
    exe,
    name='ClipCascade.app',
    icon='../../logo/logo.icns',
    bundle_identifier=None,
    info_plist={
        'LSUIElement': True,
    },
)
