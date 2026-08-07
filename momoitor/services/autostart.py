"""Windows scheduled task management for auto-start.

通过 schtasks 创建计划任务实现开机自启，直接运行目标命令，无需 VBScript 中间层。

主要方法:
- is_enabled(): 检查自动启动任务是否存在
- enable(): 创建计划任务以在登录时运行
- disable(): 删除计划任务

主要变量:
- TASK_NAME: 计划任务名称 ("MoMoitor")
"""

import os
import subprocess
import sys

from loguru import logger

from momoitor.config import DATA_DIR, PROJECT_ROOT

TASK_NAME = "MoMoitor"

_FROZEN = getattr(sys, "frozen", False)


def _command() -> str:
    """生成 schtasks 直接调用的命令（无需 VBScript）。"""
    if _FROZEN:
        return f'"{sys.executable}"'
    python_exe = sys.executable
    pythonw_exe = os.path.join(os.path.dirname(python_exe), "pythonw.exe")
    if not os.path.exists(pythonw_exe):
        pythonw_exe = python_exe
    return f'cmd /c "cd /d "{PROJECT_ROOT}" && "{pythonw_exe}" -m momoitor.main"'


def is_enabled() -> bool:
    """Check if auto-start task exists."""
    try:
        r = subprocess.run(["schtasks", "/query", "/tn", TASK_NAME], capture_output=True, text=True)
        return r.returncode == 0
    except Exception:
        return False


def _cleanup_legacy_vbs():
    """删除旧版遗留的 autostart.vbs（如存在）。"""
    vbs = os.path.join(DATA_DIR, "autostart.vbs")
    if os.path.exists(vbs):
        try:
            os.remove(vbs)
            logger.info("Removed legacy autostart.vbs")
        except OSError as e:
            logger.warning("Failed to remove legacy autostart.vbs: {}", e)


def enable() -> bool:
    """Create a scheduled task to run at logon with admin privileges."""
    try:
        _cleanup_legacy_vbs()
        subprocess.run(["schtasks", "/delete", "/tn", TASK_NAME, "/f"], capture_output=True)
        cmd = [
            "schtasks", "/create", "/tn", TASK_NAME,
            "/tr", _command(),
            "/sc", "ONLOGON", "/rl", "HIGHEST", "/f",
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            logger.info("Auto-start enabled: Task '{}' created", TASK_NAME)
            return True
        logger.error("schtasks create failed: {}", r.stderr.strip())
        return False
    except Exception as e:
        logger.error("Auto-start enable failed: {}", e)
        return False


def disable() -> bool:
    """Remove the scheduled task."""
    try:
        r = subprocess.run(["schtasks", "/delete", "/tn", TASK_NAME, "/f"], capture_output=True, text=True)
        if r.returncode == 0:
            logger.info("Auto-start disabled")
            return True
        logger.error("schtasks delete failed: {}", r.stderr.strip())
        return False
    except Exception as e:
        logger.error("Auto-start disable failed: {}", e)
        return False