"""备份/还原服务 —— 将程序使用的数据文件打包为 zip，或从备份 zip 还原。

只打包程序实际使用的数据（settings.json、wallpapers/、lyrics.db、traffic.db），
不包括日志与未使用的遗留文件。DB 文件用 SQLite 在线备份 API 生成一致性快照，
避免运行中读写导致拷贝不完整。
"""

import os
import shutil
import sqlite3
import tempfile
import time
import zipfile

from loguru import logger

from momoitor.config import DATA_DIR, SETTINGS_FILE, WALLPAPERS_DIR
from momoitor.services.lyrics import DB_PATH as LYRICS_DB_PATH
from momoitor.services.traffic import DB_PATH as TRAFFIC_DB_PATH

BACKUP_PREFIX = "momoitor-backup"

# 备份中允许还原的顶层文件名（+ wallpapers/ 目录内任意文件）
_RESTORE_ALLOWED = {"settings.json", "lyrics.db", "traffic.db"}

DB_PATHS = (LYRICS_DB_PATH, TRAFFIC_DB_PATH)


def backup_filename() -> str:
    """生成默认备份文件名，如 momoitor-backup_20260811230516.zip。"""
    return f"{BACKUP_PREFIX}_{time.strftime('%Y%m%d%H%M%S')}.zip"


def _snapshot_db_bytes(db_path: str) -> bytes:
    """用 SQLite 在线备份 API 生成一致性快照字节；失败时回退为直接读取文件。"""
    try:
        src = sqlite3.connect(db_path)
        try:
            fd, tmp = tempfile.mkstemp(suffix=".db")
            try:
                os.close(fd)
                dst = sqlite3.connect(tmp)
                try:
                    src.backup(dst)
                finally:
                    dst.close()
                with open(tmp, "rb") as f:
                    return f.read()
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
        finally:
            src.close()
    except Exception as e:
        logger.warning("SQLite snapshot failed for {}: {}, falling back to raw copy", db_path, e)
        with open(db_path, "rb") as f:
            return f.read()


def _collect_entries() -> list:
    """收集要打包的数据项：[(zip内路径, 磁盘路径) | (zip内路径, bytes)]。"""
    entries = []
    if os.path.exists(SETTINGS_FILE):
        entries.append((os.path.basename(SETTINGS_FILE), SETTINGS_FILE))
    if os.path.isdir(WALLPAPERS_DIR):
        for root, _dirs, files in os.walk(WALLPAPERS_DIR):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, DATA_DIR).replace("\\", "/")
                entries.append((rel, full))
    for db in DB_PATHS:
        if os.path.exists(db):
            entries.append((os.path.basename(db), _snapshot_db_bytes(db)))
    return entries


def build_backup_zip(dest_path: str) -> str:
    """把程序使用的数据文件打包到 dest_path（父目录不存在时自动创建）。"""
    dest_path = os.path.abspath(dest_path)
    parent = os.path.dirname(dest_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with zipfile.ZipFile(dest_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for arcname, src in _collect_entries():
            if isinstance(src, bytes):
                zf.writestr(arcname, src)
            else:
                zf.write(src, arcname=arcname)
    logger.info("Backup exported to {}", dest_path)
    return dest_path


def _has_traversal(name: str) -> bool:
    """zip 条目是否包含路径穿越（绝对路径 / 反斜杠 / .. 段）。"""
    return name.startswith("/") or "\\" in name or ".." in name.split("/")


def _is_allowed(name: str) -> bool:
    """该 zip 条目是否属于可还原的数据文件（防御 zip-slip）。"""
    if not name or name.startswith("/") or "\\" in name:
        return False
    parts = name.split("/")
    if any(p in ("", "..") for p in parts):
        return False
    if len(parts) == 1:
        return parts[0] in _RESTORE_ALLOWED
    return parts[0] == "wallpapers"


def restore_backup(zip_path: str) -> list:
    """从备份 zip 还原数据文件，返回还原的顶层数据项列表。

    先校验 zip 是有效 MoMoitor 备份（根目录含 settings.json）并把内容解压到
    临时目录，全部成功后才会覆盖当前数据；路径穿越条目会被拒绝。
    """
    zip_path = os.path.abspath(zip_path)
    if not os.path.exists(zip_path):
        raise FileNotFoundError(f"备份文件不存在: {zip_path}")

    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        if any(_has_traversal(n) for n in names):
            raise ValueError("备份文件包含非法路径，已中止还原")
        if "settings.json" not in names:
            raise ValueError("不是有效的 MoMoitor 备份（缺少 settings.json）")
        allowed = [n for n in names if _is_allowed(n)]
        if not allowed:
            raise ValueError("备份中没有可还原的数据")

        staging = tempfile.mkdtemp(prefix="momoitor-restore-")
        try:
            for name in allowed:
                zf.extract(name, staging)

            restored = []
            for name in allowed:
                src = os.path.join(staging, name.replace("/", os.sep))
                dst = os.path.join(DATA_DIR, name.replace("/", os.sep))
                if not os.path.exists(src):
                    continue
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if os.path.isdir(src):
                    os.makedirs(dst, exist_ok=True)
                    for item in os.listdir(src):
                        shutil.move(os.path.join(src, item), os.path.join(dst, item))
                    os.rmdir(src)
                else:
                    shutil.move(src, dst)
                top = name.split("/")[0]
                if top not in restored:
                    restored.append(top)
        finally:
            shutil.rmtree(staging)

    logger.info("Backup restored from {}: {}", zip_path, ", ".join(restored))
    return restored
