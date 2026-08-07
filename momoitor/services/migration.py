"""Migration from legacy auto-start to current mechanism.

从旧版计划任务 + VBScript 方案迁移到注册表 Run 键方案。
"""

import os
import subprocess
import winreg

from loguru import logger

from momoitor.config import DATA_DIR

_OLD_TASK_NAME = "MoMoitor"
_OLD_VBS_FILE = "autostart.vbs"
_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_ENTRY_NAME = "MoMoitor"


def _old_task_exists() -> bool:
    try:
        r = subprocess.run(
            ["schtasks", "/query", "/tn", _OLD_TASK_NAME],
            capture_output=True, text=True,
        )
        return r.returncode == 0
    except Exception:
        return False


def _delete_old_task():
    try:
        subprocess.run(
            ["schtasks", "/delete", "/tn", _OLD_TASK_NAME, "/f"],
            capture_output=True,
        )
        logger.info("Legacy scheduled task deleted")
    except Exception as e:
        logger.warning("Failed to delete legacy scheduled task: {}", e)


def _delete_vbs():
    vbs_path = os.path.join(DATA_DIR, _OLD_VBS_FILE)
    if os.path.exists(vbs_path):
        try:
            os.remove(vbs_path)
            logger.info("Legacy autostart.vbs deleted")
        except OSError as e:
            logger.warning("Failed to delete autostart.vbs: {}", e)


def _ensure_run_key(command: str) -> bool:
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE
        ) as key:
            winreg.SetValueEx(key, _ENTRY_NAME, 0, winreg.REG_SZ, command)
        return True
    except Exception as e:
        logger.warning("Failed to create Run key entry: {}", e)
        return False


def migrate_autostart(command: str) -> bool:
    """Migrate from legacy auto-start (scheduled task + VBScript) to Registry Run key.

    Returns True if migration was performed, False if nothing to migrate.
    """
    has_old_task = _old_task_exists()
    if not has_old_task:
        return False

    logger.info("Legacy auto-start detected, migrating to Registry Run key")

    _delete_old_task()
    _delete_vbs()
    _ensure_run_key(command)

    logger.info("Auto-start migration completed")
    return True


def clean_legacy_artifacts():
    """Clean up orphaned legacy files without creating the new Run key entry."""
    _delete_vbs()