"""备份服务测试：打包/还原往返、无效备份拒绝、路径穿越防御。"""

import os
import shutil
import sqlite3
import zipfile

import pytest

from momoitor.services import backup as svc


@pytest.fixture
def data_dir(tmp_path):
    """把备份服务指向一个临时数据目录，并准备样本数据。"""
    data = tmp_path / "data"
    data.mkdir()
    svc.DATA_DIR = str(data)
    svc.SETTINGS_FILE = str(data / "settings.json")
    svc.WALLPAPERS_DIR = str(data / "wallpapers")
    svc.DB_PATHS = (str(data / "lyrics.db"), str(data / "traffic.db"))

    (data / "settings.json").write_text('{"schema_version": 2}', encoding="utf-8")
    (data / "wallpapers").mkdir()
    (data / "wallpapers" / "a.png").write_bytes(b"img-bytes")

    conn = sqlite3.connect(str(data / "lyrics.db"))
    conn.execute("CREATE TABLE t(x)")
    conn.execute("INSERT INTO t VALUES (42)")
    conn.commit()
    conn.close()
    (data / "traffic.db").write_bytes(b"not-really-sqlite")  # 走快照失败回退分支
    return data


def test_backup_filename_format():
    name = svc.backup_filename()
    assert name.startswith("momoitor-backup_")
    assert name.endswith(".zip")
    assert len(name) == len("momoitor-backup_") + 8 + 6 + len(".zip")


def test_export_contains_program_data(data_dir, tmp_path):
    dest = tmp_path / "out" / svc.backup_filename()
    svc.build_backup_zip(str(dest))
    assert dest.exists()
    with zipfile.ZipFile(str(dest)) as zf:
        names = zf.namelist()
        assert "settings.json" in names
        assert "wallpapers/a.png" in names
        assert "lyrics.db" in names
        assert "traffic.db" in names
        assert not any(n.startswith("momonitor") and n.endswith(".log") for n in names)


def test_restore_roundtrip(data_dir, tmp_path):
    dest = tmp_path / "out" / svc.backup_filename()
    svc.build_backup_zip(str(dest))

    shutil.rmtree(str(data_dir))
    data_dir.mkdir()

    restored = svc.restore_backup(str(dest))
    assert "settings.json" in restored
    assert "wallpapers" in restored
    assert "lyrics.db" in restored
    assert "traffic.db" in restored

    assert (data_dir / "settings.json").read_text(encoding="utf-8") == '{"schema_version": 2}'
    assert (data_dir / "wallpapers" / "a.png").read_bytes() == b"img-bytes"
    conn = sqlite3.connect(str(data_dir / "lyrics.db"))
    assert conn.execute("SELECT x FROM t").fetchone()[0] == 42
    conn.close()
    assert (data_dir / "traffic.db").read_bytes() == b"not-really-sqlite"


def test_restore_rejects_missing_settings(tmp_path):
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(str(bad), "w") as zf:
        zf.writestr("random.txt", "x")
    with pytest.raises(ValueError, match="settings.json"):
        svc.restore_backup(str(bad))


def test_restore_rejects_traversal(data_dir, tmp_path):
    evil = tmp_path / "evil.zip"
    with zipfile.ZipFile(str(evil), "w") as zf:
        zf.writestr("settings.json", "{}")
        zf.writestr("wallpapers/../../evil.txt", "boom")
    with pytest.raises(ValueError, match="非法路径"):
        svc.restore_backup(str(evil))
    assert not (tmp_path / "evil.txt").exists()
