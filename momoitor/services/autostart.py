"""Windows scheduled task management for auto-start.

主要方法:
- is_enabled(): 检查自动启动任务是否存在
- enable(): 创建计划任务以在登录时运行
- disable(): 删除计划任务

主要变量:
- TASK_NAME: 计划任务名称 ("MoMoitor")
"""

import os
import sys

from loguru import logger

from momoitor.common import run_hidden
from momoitor.config import PROJECT_ROOT

TASK_NAME = "MoMoitor"

_FROZEN = getattr(sys, "frozen", False)


def _vbs_location() -> str:
    """autostart.vbs 始终写入 %LOCALAPPDATA%\\MoMoitor（用户级、始终可写），两种模式一致。

    注意：与用户数据目录（打包版为程序运行目录）无关——该文件由计划任务调用，
    必须位于用户始终可写的位置。
    """
    _appdata = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(_appdata, "MoMoitor")


def _vbs_content() -> str:
    """生成 autostart.vbs 内容（当前运行形态对应调用）。"""
    if _FROZEN:
        # 打包版：直接运行 exe 本身。
        # 带引号路径在 VBS 里 = 开头引号 + 转义引号 + 路径 + 转义引号 + 结尾引号，即两侧各 3 个引号。
        return (
            'Set WshShell = CreateObject("WScript.Shell")\n'
            f'WshShell.Run """{sys.executable}""", 0, False\n'
        )
    python_exe = sys.executable
    pythonw_exe = os.path.join(os.path.dirname(python_exe), "pythonw.exe")
    if not os.path.exists(pythonw_exe):
        pythonw_exe = python_exe
    return (
        'Set WshShell = CreateObject("WScript.Shell")\n'
        f'WshShell.CurrentDirectory = "{PROJECT_ROOT}"\n'
        f'WshShell.Run """{pythonw_exe}"" ""-m"" ""momoitor.main""", 0, False\n'
    )


def is_enabled() -> bool:
    """Check if auto-start task exists."""
    try:
        r = run_hidden(["schtasks", "/query", "/tn", TASK_NAME], text=True)
        return r.returncode == 0
    except Exception:
        return False


def enable() -> bool:
    """Create a scheduled task to run at logon."""
    try:
        run_hidden(["schtasks", "/delete", "/tn", TASK_NAME, "/f"])
        vbs_path = os.path.join(_vbs_location(), "autostart.vbs")
        os.makedirs(os.path.dirname(vbs_path), exist_ok=True)
        with open(vbs_path, "w", encoding="utf-8") as f:
            f.write(_vbs_content())
        cmd = [
            "schtasks", "/create", "/tn", TASK_NAME,
            "/tr", f'wscript.exe "{vbs_path}"',
            "/sc", "ONLOGON", "/rl", "LIMITED", "/f",
        ]
        r = run_hidden(cmd)
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
        r = run_hidden(["schtasks", "/delete", "/tn", TASK_NAME, "/f"], text=True)
        if r.returncode == 0:
            logger.info("Auto-start disabled")
            return True
        logger.error("schtasks delete failed: {}", r.stderr.strip())
        return False
    except Exception as e:
        logger.error("Auto-start disable failed: {}", e)
        return False
