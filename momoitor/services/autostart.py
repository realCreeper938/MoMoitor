"""通过 Windows 计划任务实现开机自启动。"""

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


def _find_venv_pythonw() -> str:
    """返回项目根目录下虚拟环境的 pythonw.exe 路径，不存在则返回空字符串。"""
    for name in (".venv", "venv"):
        exe = os.path.join(PROJECT_ROOT, name, "Scripts", "pythonw.exe")
        if os.path.exists(exe):
            return exe
    return ""


def _vbs_content() -> str:
    """生成 autostart.vbs 内容（当前运行形态对应调用）。"""
    if _FROZEN:
        # 打包版：直接运行 exe 本身。
        # 带引号路径在 VBS 里 = 开头引号 + 转义引号 + 路径 + 转义引号 + 结尾引号，即两侧各 3 个引号。
        return (
            'Set WshShell = CreateObject("WScript.Shell")\n'
            f'WshShell.Run """{sys.executable}""", 0, False\n'
        )
    # 源码运行：优先使用项目内虚拟环境，其次回退到当前解释器同目录的 pythonw。
    pythonw_exe = _find_venv_pythonw()
    if not pythonw_exe:
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


def _cmd_to_batch_line(cmd: list) -> str:
    """把命令列表拼成 cmd.exe 可执行的一行（内部引号按 cmd 规则转义）。"""
    parts = []
    for a in cmd:
        if '"' in a:
            a = a.replace('"', '""')
        parts.append(f'"{a}"')
    return " ".join(parts)


def _run_batch_elevated(lines: list) -> bool:
    """以管理员权限（UAC 提示）执行多行 cmd 命令，返回是否全部成功。

    当前进程非管理员时，schtasks 创建/删除计划任务会返回 Access Denied；
    此函数把命令写入临时 .cmd 文件后用 PowerShell Start-Process -Verb RunAs
    提升执行，等待退出并校验退出码。
    """
    import tempfile
    fd, bat = None, None
    try:
        fd, bat = tempfile.mkstemp(prefix="momo_autostart_", suffix=".cmd")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            fd = None
            f.write("\r\n".join(lines) + "\r\n")
        ps = (
            "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',"
            f"'{bat}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
        )
        r = run_hidden(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps])
        return r.returncode == 0
    except Exception as e:
        logger.error("Elevated schtasks failed: {}", e)
        return False
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if bat:
            try:
                os.remove(bat)
            except OSError:
                pass


def enable() -> bool:
    """Create a scheduled task to run at logon with highest privileges."""
    try:
        vbs_path = os.path.join(_vbs_location(), "autostart.vbs")
        os.makedirs(os.path.dirname(vbs_path), exist_ok=True)
        with open(vbs_path, "w", encoding="utf-8") as f:
            f.write(_vbs_content())
        create_cmd = [
            "schtasks", "/create", "/tn", TASK_NAME,
            "/tr", f'wscript.exe "{vbs_path}"',
            "/sc", "ONLOGON", "/rl", "HIGHEST", "/f",
        ]
        # 先尝试直接创建（当前进程已提权时成功）
        run_hidden(["schtasks", "/delete", "/tn", TASK_NAME, "/f"])
        r = run_hidden(create_cmd)
        if r.returncode == 0:
            logger.info("Auto-start enabled: Task '{}' created (highest privileges)", TASK_NAME)
            return True
        # 非管理员进程：delete + create 整体通过 UAC 提升执行一次
        lines = [
            _cmd_to_batch_line(["schtasks", "/delete", "/tn", TASK_NAME, "/f"]),
            _cmd_to_batch_line(create_cmd),
        ]
        if _run_batch_elevated(lines):
            logger.info("Auto-start enabled: Task '{}' created via elevation", TASK_NAME)
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
        if _run_batch_elevated([_cmd_to_batch_line(["schtasks", "/delete", "/tn", TASK_NAME, "/f"])]):
            logger.info("Auto-start disabled (elevated)")
            return True
        logger.error("schtasks delete failed: {}", r.stderr.strip())
        return False
    except Exception as e:
        logger.error("Auto-start disable failed: {}", e)
        return False
