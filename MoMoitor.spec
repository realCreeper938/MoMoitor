# -*- mode: python ; coding: utf-8 -*-
# MoMoitor PyInstaller spec — onedir build, run from repo root:
#   python -m PyInstaller --noconfirm MoMoitor.spec
# (or via scripts/build.py)

import os
import re

from PyInstaller.utils.hooks import collect_dynamic_libs

ROOT = os.path.abspath(SPECPATH)  # repo root — SPECPATH 即 spec 所在目录（PyInstaller 提供）

# 版本号唯一来源：momoitor/config.py（正则读取，不执行模块代码）
_src = open(os.path.join(ROOT, "momoitor", "config.py"), encoding="utf-8").read()
_m = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', _src)
APP_VERSION = _m.group(1) if _m else "1.0.0"

datas = []
binaries = []

# 前端：排除用户私有内容（bg/ 壁纸、运行时生成的系统壁纸副本）。
# 注意不能用 Tree 的 (目标, 源) 三元组简单翻转：
# format_binaries_and_datas 把 datas 条目的第二项当作「目标目录」，会把文件塞成
# web/index.html/index.html。正确做法是每个文件给 (源文件, 目标目录)，目录名+文件名拼接。
def _collect_web(web_dir):
    entries = []
    for dirpath, dirnames, filenames in os.walk(web_dir):
        dirnames[:] = [d for d in dirnames if d not in ("bg",)]
        rel = os.path.relpath(dirpath, web_dir)
        target_dir = "web" if rel == "." else os.path.join("web", rel)
        for fn in filenames:
            if fn in ("system_wallpaper.jpg", "system_wallpaper.png"):
                continue
            entries.append((os.path.join(dirpath, fn), target_dir))
    return entries

datas += _collect_web(os.path.join(ROOT, "momoitor", "web"))
# LHM 运行时 DLL（clr.AddReference 通过 LoadFrom 语义解析同目录依赖）
datas += [(os.path.join(ROOT, "momoitor", "libs"), "libs")]
# 托盘图标（services/tray.py 运行时读取）
datas += [(os.path.join(ROOT, "assets", "app.ico"), "assets")]
# 第三方组件许可文本（随包分发，满足 MPL-2.0/OFL/LGPL 附带许可要求）
datas += [(os.path.join(ROOT, "LICENSES"), "LICENSES")]

# winrt 命名空间包没有 PyInstaller hook：打包其运行时 DLL（msvcp140.dll）
binaries += collect_dynamic_libs("winrt")

hiddenimports = [
    "winrt.runtime",
    "winrt.system",
    "winrt.windows.media.control",
    "winrt.windows.storage.streams",
    # plyer 用动态 __import__ 分派平台模块，需显式声明
    "plyer.platforms.win.notification",
    "plyer.platforms.win.libs.balloontip",
    "plyer.platforms.win.libs.win_api_defs",
    # pystray 按平台函数内延迟导入后端，显式声明保险
    "pystray._win32",
]

_icon = os.path.join(ROOT, "assets", "app.ico")
_version = os.path.join(ROOT, "build", "version_info.txt")

a = Analysis(
    [os.path.join(ROOT, "momoitor", "main.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[os.path.join(ROOT, "scripts", "runtime_boot.py")],
    excludes=[
        # 已确认不被应用引用的重 stdlib（http.server/sqlite3 等被用到，须保留；
        # distutils/lib2to3 由 PyInstaller 内部处理，不能在此排除）
        "tkinter", "chardet",
        "unittest", "test", "ensurepip", "idlelib", "turtle", "turtledemo",
        "xmlrpc", "curses", "venv", "pydoc_data",
        "doctest", "pydoc", "smtplib", "imaplib", "nntplib", "mailbox", "telnetlib",
        # comtypes 的 numpy 互操作仅在显式 enable 时使用，本项目未启用，排除可省约 6MB
        "numpy", "scipy",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="MoMoitor",
    debug=False,
    strip=False,
    # 启用 UPX 压缩（机器上无 upx 时 PyInstaller 自动跳过，不影响打包）
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    icon=_icon if os.path.exists(_icon) else None,
    version=_version if os.path.exists(_version) else None,
    uac_admin=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    # 启用 UPX 压缩（机器上无 upx 时 PyInstaller 自动跳过，不影响打包）
    upx=True,
    name="MoMoitor",
)
