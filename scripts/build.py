#!/usr/bin/env python3
"""MoMoitor 构建与发布脚本。

子命令:
    check      编译检查（Python compileall + 前端 JS 语法检查）
    build      打包 exe（PyInstaller onedir）→ zip + SHA-256
    run        开发模式启动 (python -m momoitor.main)
    release    提升版本号 + 提交 + 打 tag（--dry-run 预览）

示例:
    python scripts/build.py check
    python scripts/build.py build --clean
    python scripts/build.py release --version 1.1.0
    python scripts/build.py release --version 1.1.0 --dry-run
"""

import argparse
import fnmatch
import hashlib
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PY = os.path.join(ROOT, "momoitor", "config.py")
VERSION_RE = re.compile(r'APP_VERSION\s*=\s*"([^"]+)"')
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
DIST_DIR = os.path.join(ROOT, "dist")
BUILD_DIR = os.path.join(ROOT, "build")


def read_version() -> str:
    """从 momoitor/config.py 读取版本号（唯一来源）。"""
    with open(CONFIG_PY, encoding="utf-8") as f:
        m = VERSION_RE.search(f.read())
    if not m:
        raise SystemExit("ERROR: APP_VERSION not found in momoitor/config.py")
    return m.group(1)


def write_version_info(version: str) -> str:
    """生成 PyInstaller version_info.txt（Windows 文件属性）。"""
    try:
        from PyInstaller.utils.win32.versioninfo import (
            FixedFileInfo, StringFileInfo, StringStruct, StringTable,
            VarFileInfo, VarStruct, VSVersionInfo,
        )
    except ImportError:
        return ""
    ver_parts = [int(p) for p in (version.split(".") + ["0", "0"])[:4]]
    info = VSVersionInfo(
        ffi=FixedFileInfo(
            filevers=ver_parts, prodvers=ver_parts,
            mask=0x3F, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0,
            date=(0, 0),
        ),
        kids=[
            StringFileInfo([
                StringTable("040904B0", [
                    StringStruct("CompanyName", "MoMoitor"),
                    StringStruct("FileDescription", "MoMoitor - Windows Hardware Monitor"),
                    StringStruct("FileVersion", version),
                    StringStruct("InternalName", "MoMoitor"),
                    StringStruct("OriginalFilename", "MoMoitor.exe"),
                    StringStruct("ProductName", "MoMoitor"),
                    StringStruct("ProductVersion", version),
                ]),
            ]),
            VarFileInfo([VarStruct("Translation", [1033, 1200])]),
        ],
    )
    os.makedirs(BUILD_DIR, exist_ok=True)
    path = os.path.join(BUILD_DIR, "version_info.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(str(info))
    return path


def cmd_check() -> int:
    """编译检查：Python compileall + node --check 前端 JS。"""
    failed = False

    print("== Python compileall ==")
    result = subprocess.run(
        [sys.executable, "-m", "compileall", "-q", "momoitor", "scripts"],
        cwd=ROOT,
    )
    failed = failed or result.returncode != 0
    print("PASS" if result.returncode == 0 else "FAIL")

    print("== node --check (web js) ==")
    if shutil.which("node"):
        js_files = []
        web_dir = os.path.join(ROOT, "momoitor", "web")
        for dirpath, _dirs, names in os.walk(web_dir):
            for name in names:
                if name.endswith(".js"):
                    js_files.append(os.path.join(dirpath, name))
        for js in sorted(js_files):
            result = subprocess.run(["node", "--check", js], cwd=ROOT)
            if result.returncode != 0:
                failed = True
                print("FAIL", os.path.relpath(js, ROOT))
        if not failed:
            print(f"PASS ({len(js_files)} files)")
    else:
        print("SKIP (node not found)")

    return 1 if failed else 0


def cmd_build(clean: bool) -> int:
    """PyInstaller onedir 打包 → zip → SHA-256。"""
    version = read_version()
    print(f"== Building v{version} ==")
    if clean:
        for d in (DIST_DIR, BUILD_DIR):
            if os.path.isdir(d):
                shutil.rmtree(d)

    write_version_info(version)

    args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "MoMoitor.spec"]
    if clean:
        args.insert(-1, "--clean")
    result = subprocess.run(args, cwd=ROOT)
    if result.returncode != 0:
        return result.returncode

    exe_dir = os.path.join(DIST_DIR, "MoMoitor")
    if not os.path.isfile(os.path.join(exe_dir, "MoMoitor.exe")):
        print("ERROR: dist/MoMoitor/MoMoitor.exe not found after build")
        return 1

    zip_name = f"MoMoitor-v{version}-win64.zip"
    zip_path = os.path.join(DIST_DIR, zip_name)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for dirpath, _dirs, names in os.walk(exe_dir):
            for name in names:
                full = os.path.join(dirpath, name)
                arc = os.path.join("MoMoitor", os.path.relpath(full, exe_dir))
                zf.write(full, arc)

    sha = hashlib.sha256(open(zip_path, "rb").read()).hexdigest()
    size_mb = os.path.getsize(zip_path) / 1024 / 1024
    print(f"== Done ==")
    print(f"zip:  {os.path.join('dist', zip_name)} ({size_mb:.1f} MB)")
    print(f"sha256: {sha}")
    return 0


def cmd_run() -> int:
    """开发模式启动。"""
    print("== python -m momoitor.main ==")
    return subprocess.run([sys.executable, "-m", "momoitor.main"], cwd=ROOT).returncode


def cmd_release(version: str, dry_run: bool) -> int:
    """提升版本号 → 提交 → 注解 tag vX.Y.Z。"""
    if not VERSION_PATTERN.match(version):
        print("ERROR: version must match X.Y.Z (e.g. 1.1.0)")
        return 1
    if version == read_version():
        print(f"ERROR: version {version} already set in momoitor/config.py")
        return 1

    def git(args):
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)

    status = git(["status", "--porcelain"])
    if status.stdout.strip():
        print("ERROR: working tree is dirty, commit or stash first")
        print(status.stdout[:500])
        return 1

    tag = f"v{version}"
    tag_check = git(["rev-parse", "-q", "--verify", "refs/tags/" + tag])
    if tag_check.returncode == 0:
        print(f"ERROR: tag {tag} already exists")
        return 1

    print(f"== Release {version} ==")
    print(f"1. bump APP_VERSION in momoitor/config.py -> {version}")
    with open(CONFIG_PY, encoding="utf-8") as f:
        content = f.read()
    content = VERSION_RE.sub(f'APP_VERSION = "{version}"', content, count=1)
    if not dry_run:
        with open(CONFIG_PY, "w", encoding="utf-8") as f:
            f.write(content)
    print(f"2. git add -A && git commit -m 'chore: bump version to {version}'")
    if not dry_run:
        git(["add", "-A"])
        git(["commit", "-m", f"chore: bump version to {version}"])
    print(f"3. git tag -a {tag} -m 'Release {version}'")
    if not dry_run:
        git(["tag", "-a", tag, "-m", f"Release {version}"])
    print("== Done (push tag to trigger CI: git push origin", tag + ") ==")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="MoMoitor build & release script")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check", help="compileall + node --check")
    p_build = sub.add_parser("build", help="PyInstaller onedir + zip + sha256")
    p_build.add_argument("--clean", action="store_true", help="wipe dist/ and build/ first")
    sub.add_parser("run", help="python -m momoitor.main")
    p_release = sub.add_parser("release", help="bump version, commit, tag")
    p_release.add_argument("--version", required=True, help="new version X.Y.Z")
    p_release.add_argument("--dry-run", action="store_true", help="print steps without executing")

    args = parser.parse_args()
    if args.command == "check":
        return cmd_check()
    if args.command == "build":
        return cmd_build(args.clean)
    if args.command == "run":
        return cmd_run()
    if args.command == "release":
        return cmd_release(args.version, args.dry_run)
    return 1


if __name__ == "__main__":
    sys.exit(main())
