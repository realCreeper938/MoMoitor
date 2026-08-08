"""MoMoitor - Windows 硬件监视器。

主要方法:
- main(): 应用程序入口点，初始化硬件监视器并启动webview窗口或HTTP服务器
- _cleanup_webview2_data(): 清理WebView2用户数据文件夹中的过时锁文件
- _hide_console(): 隐藏控制台窗口，只显示webview界面

主要变量:
- logger: loguru日志实例，配置为输出到stderr和momonitor.log文件
- SETTINGS_FILE: 设置文件路径（来自config模块）
- WEB_DIR: 前端web文件目录路径
"""

import ctypes
import os
import sys
import time
import traceback
import momoitor.webview_compat  # noqa: F401  （pywebview+bottle 兼容修复，须在 webview 前导入）
import webview
from loguru import logger
from momoitor.config import load_settings, DATA_DIR
from momoitor.api import create_monitor, create_window, create_api

logger.remove()

# debug 日志级别：默认关闭（INFO），可在「设置 → 高级 → Debug Logs」开启。
# 需在 main() 之前读取设置以决定日志级别，因此这里加载一次。
def _logging_level() -> str:
    try:
        s = load_settings()
        return "DEBUG" if s.get("debug_logs") else "INFO"
    except Exception:
        return "INFO"


_log_level = _logging_level()
logger.add(sys.stderr, level=_log_level, format="<green>{time:HH:mm:ss.SSS}</green> | <level>{level:<7}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - {message}")
logger.add(os.path.join(DATA_DIR, "momonitor.log"), rotation="1 MB", retention="7 days", level=_log_level)


def _cleanup_webview2_data():
    """清理崩溃会话遗留的 WebView2 用户数据目录中的过期锁文件。"""
    local_app = os.environ.get("LOCALAPPDATA", "")
    if not local_app:
        return
    for name in ("MoMoitor", "pywebview"):
        folder = os.path.join(local_app, name)
        lock_file = os.path.join(folder, "lockfile")
        if os.path.exists(lock_file):
            try:
                os.remove(lock_file)
                logger.debug("Removed stale lockfile: {}", lock_file)
            except OSError:
                pass


def _hide_console():
    """隐藏控制台窗口（若有），只显示 webview 界面。"""
    SW_HIDE = 0
    hwnd = ctypes.windll.kernel32.GetConsoleWindow()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, SW_HIDE)


def _show_error(title, msg):
    """GUI 模式下弹出错误对话框。打包为无控制台 exe，崩溃必须可见而非静默。"""
    try:
        ctypes.windll.user32.MessageBoxW(0, msg, title, 0x10)  # MB_OK | MB_ICONERROR
    except Exception:
        pass


def _run_webview(monitor, settings, t0):
    """启动 pywebview 窗口模式。"""
    logger.debug("Creating webview window")
    _hide_console()
    window, api = create_window(monitor)
    logger.info("Window created ({:.0f}ms), entering event loop", (time.monotonic() - t0) * 1000)
    debug = bool(settings.get("debug", False))
    webview.start(debug=debug)
    logger.debug("Event loop exited normally")
    return api


def _run_server(monitor, settings, t0):
    """启动 HTTP 服务器模式。"""
    from momoitor.server import run_server
    api = create_api(monitor)
    logger.info("API ready ({:.0f}ms), starting HTTP server", (time.monotonic() - t0) * 1000)
    run_server(api, settings)
    return api


def _migrate_legacy_autostart():
    """启动时自动迁移旧版开机自启（计划任务 + VBScript）到注册表 Run 键。"""
    try:
        from momoitor.services.migration import migrate_autostart
        from momoitor.services.autostart import get_command
        migrate_autostart(get_command())
    except Exception as e:
        logger.warning("Legacy auto-start migration failed: {}", e)


def main():
    t0 = time.monotonic()
    logger.info("Starting MoMoitor")
    _cleanup_webview2_data()
    _migrate_legacy_autostart()
    settings = load_settings()
    try:
        logger.debug("Initializing hardware monitor")
        monitor = create_monitor()
        logger.info("Hardware monitor ready ({:.0f}ms)", (time.monotonic() - t0) * 1000)
    except Exception as e:
        logger.error("Monitor init failed: {}", e)
        logger.debug(traceback.format_exc())
        _show_error("MoMoitor 启动失败", "硬件监视器初始化失败，无法启动：\n\n" + str(e))
        return
    try:
        if settings.get("server_mode", False):
            api = _run_server(monitor, settings, t0)
        else:
            api = _run_webview(monitor, settings, t0)
    except Exception as e:
        logger.error("Runtime error: {}", e)
        logger.debug(traceback.format_exc())
        _show_error("MoMoitor 出错", "运行时错误：\n\n" + str(e))
    finally:
        if "api" in locals():
            api.close_monitor()
        else:
            monitor.close()
        logger.info("MoMoitor exited")


if __name__ == "__main__":
    main()
