"""Auto-start management via Windows Registry Run key.

使用注册表 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run 实现开机自启，
无需计划任务、无需 VBScript 中间层，用户可在任务管理器「启动」页签直接管理。

主要方法:
- is_enabled(): 检查 Run 键中是否存在自启条目
- enable(): 写入 Run 键实现开机自启
- disable(): 删除 Run 键中的自启条目

主要变量:
- ENTRY_NAME: Run 键中的值名称 ("MoMoitor")
"""

import os
import sys
import winreg

from loguru import logger

from momoitor.config import PROJECT_ROOT
from momoitor.services.migration import migrate_autostart

ENTRY_NAME = "MoMoitor"

_FROZEN = getattr(sys, "frozen", False)

_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def get_command() -> str:
    """生成自启命令（当前运行形态对应调用）。"""
    if _FROZEN:
        # 打包版：直接运行 exe 本身。
        return f'"{sys.executable}"'
    python_exe = sys.executable
    pythonw_exe = os.path.join(os.path.dirname(python_exe), "pythonw.exe")
    if not os.path.exists(pythonw_exe):
        pythonw_exe = python_exe
    # 源码版：用 pythonw 运行模块，并指定工作目录为项目根。
    return f'cmd /c "cd /d "{PROJECT_ROOT}" && "{pythonw_exe}" -m momoitor.main"'


def is_enabled() -> bool:
    """Check if Run key entry exists."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_READ) as key:
            winreg.QueryValueEx(key, ENTRY_NAME)
            return True
    except FileNotFoundError:
        return False
    except Exception as e:
        logger.error("Auto-start check failed: {}", e)
        return False


def enable() -> bool:
    """Write the Run key entry to enable auto-start."""
    migrate_autostart(get_command())
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE
        ) as key:
            winreg.SetValueEx(key, ENTRY_NAME, 0, winreg.REG_SZ, get_command())
        logger.info("Auto-start enabled via Registry Run key")
        return True
    except Exception as e:
        logger.error("Auto-start enable failed: {}", e)
        return False


def disable() -> bool:
    """Remove the Run key entry."""
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE
        ) as key:
            winreg.DeleteValue(key, ENTRY_NAME)
        logger.info("Auto-start disabled")
        return True
    except FileNotFoundError:
        return True
    except Exception as e:
        logger.error("Auto-start disable failed: {}", e)
        return False