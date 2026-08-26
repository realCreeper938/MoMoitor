"""单实例守护：防止重复运行，被拒绝的实例聚焦已有窗口后退出。

采用排他文件锁（CreateFileW + dwShareMode=0）而非命名互斥体：进程崩溃时
文件句柄被系统释放，不会留下"孤儿互斥体"导致后续启动被误判为正在运行。
重复启动的实例在 main() 早期即判定并退出，不初始化硬件监视器等重资源。
"""

import ctypes
import os
import time

from loguru import logger

from momoitor.config import DATA_DIR
from momoitor.services import window as win_svc

_LOCK_FILE = os.path.join(DATA_DIR, "instance.lock")
_ERROR_SHARING_VIOLATION = 32
_INVALID_HANDLE = ctypes.c_void_p(-1).value
_handle = None


def acquire() -> bool:
    """尝试获取单实例锁。

    返回 True 表示本进程应继续运行（已成为唯一实例）；
    返回 False 表示已有实例在运行，本进程已请求其聚焦窗口，应直接退出。
    """
    global _handle
    os.makedirs(DATA_DIR, exist_ok=True)
    kernel32 = ctypes.windll.kernel32
    # HANDLE 是指针宽度的整型；windll 默认 restype=c_int 会高位截断返回的句柄，
    # 必须显式设为 c_void_p，否则失败句柄 -1 会被截断、与 INVALID_HANDLE_VALUE 误判。
    kernel32.CreateFileW.restype = ctypes.c_void_p
    GENERIC_RW = 0x40000000 | 0x80000000
    OPEN_ALWAYS = 4
    # 请求独占访问：若另一实例正持有锁文件句柄，本次打开会返回共享冲突。
    h = kernel32.CreateFileW(
        _LOCK_FILE, GENERIC_RW, 0, None, OPEN_ALWAYS, 0x80, None)  # 0x80 = FILE_ATTRIBUTE_NORMAL
    err = kernel32.GetLastError()
    if h is None or h == _INVALID_HANDLE:
        if err == _ERROR_SHARING_VIOLATION:
            logger.info("Another MoMoitor instance is running, activating its window")
            focus_existing()
            return False
        # 其它错误（权限等）：放行，避免误伤正常启动
        logger.warning("Could not acquire instance lock (err={}), proceeding anyway", err)
        return True
    _handle = h
    return True


def focus_existing(retries: int = 5, delay: float = 0.4) -> bool:
    """找到并聚焦已运行实例的窗口。

    重复实例可能先于首个实例的窗口创建完成，故多试几次；始终找不到窗口
    （如首个实例为无窗口的服务端模式）时返回 False。
    """
    for _ in range(retries):
        hwnd = win_svc._find_window_by_title()
        if hwnd:
            win_svc.focus_hwnd(hwnd)
            logger.info("Activated existing MoMoitor window (HWND {})", hwnd)
            return True
        time.sleep(delay)
    logger.info("No existing window to activate")
    return False


def release():
    """释放单实例锁。进程结束前调用；未持有时无效果。"""
    global _handle
    if _handle:
        try:
            ctypes.windll.kernel32.CloseHandle(_handle)
        except Exception as e:
            logger.debug("Close instance lock failed: {}", e)
        _handle = None
