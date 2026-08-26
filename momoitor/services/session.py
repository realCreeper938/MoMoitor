"""Windows 会话状态监听 —— 锁屏时通知、解锁后通知。

Windows 会把锁屏时钟/登录界面显示在存在全屏窗口的显示器上。通过监听
WM_WTSSESSION_CHANGE，程序可在锁定瞬间隐藏自身窗口，使登录界面回到主显示器。

在专用线程内创建一个隐藏窗口并注册会话通知（WTSRegisterSessionNotification），
消息循环收到 WTS_SESSION_LOCK / WTS_SESSION_UNLOCK 后回调 on_lock / on_unlock。
"""

import ctypes
from ctypes import wintypes
import sys
import threading

from loguru import logger

user32 = ctypes.WinDLL("user32", use_last_error=True)
wtsapi32 = ctypes.WinDLL("wtsapi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WM_WTSSESSION_CHANGE = 0x02B1
WTS_SESSION_LOCK = 0x0007
WTS_SESSION_UNLOCK = 0x0008
NOTIFY_FOR_THIS_SESSION = 0x0
WM_QUIT = 0x0012

WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_longlong, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)

user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.DefWindowProcW.restype = ctypes.c_longlong
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
]
user32.CreateWindowExW.restype = wintypes.HWND
user32.GetMessageW.argtypes = [wintypes.LPMSG, wintypes.HWND, wintypes.UINT, wintypes.UINT]
user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
kernel32.GetCurrentThreadId.restype = wintypes.DWORD
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
wtsapi32.WTSRegisterSessionNotification.argtypes = [wintypes.HWND, wintypes.DWORD]
wtsapi32.WTSRegisterSessionNotification.restype = wintypes.BOOL
wtsapi32.WTSUnRegisterSessionNotification.argtypes = [wintypes.HWND]
wtsapi32.WTSUnRegisterSessionNotification.restype = wintypes.BOOL

_class_name = "MoMoitorSessionWatchWnd"

_watcher = None


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", ctypes.c_void_p),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


def start(on_lock, on_unlock):
    """启动会话监听（幂等），返回 watcher；非 Windows 返回 None。"""
    global _watcher
    if sys.platform != "win32":
        return None
    if _watcher is not None:
        return _watcher
    _watcher = _SessionWatcher(on_lock, on_unlock)
    _watcher.start()
    logger.debug("Session watcher started")
    return _watcher


def stop():
    """停止会话监听（若在运行）。"""
    global _watcher
    if _watcher is None:
        return
    _watcher.stop()
    _watcher = None
    logger.debug("Session watcher stopped")


class _SessionWatcher:
    """在专用线程接收 WM_WTSSESSION_CHANGE 并转发为 Python 回调。"""

    def __init__(self, on_lock, on_unlock):
        self._on_lock = on_lock
        self._on_unlock = on_unlock
        self._thread = None
        self._thread_id = 0
        self._hwnd = None
        self._wndproc_ref = None

    def start(self):
        self._thread = threading.Thread(target=self._run, name="session-watch", daemon=True)
        self._thread.start()

    def stop(self):
        if self._thread is None:
            return
        if self._thread_id and self._thread.is_alive():
            user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
            self._thread.join(timeout=3)
            if self._thread.is_alive():
                logger.warning("Session watcher thread did not exit in time")
        self._thread = None

    def _run(self):
        """监听线程主体：建窗口 -> 注册通知 -> 消息循环 -> 清理。"""
        try:
            self._thread_id = kernel32.GetCurrentThreadId()
            self._wndproc_ref = WNDPROC(self._proc)

            wc = WNDCLASSW()
            wc.lpfnWndProc = self._wndproc_ref
            wc.hInstance = kernel32.GetModuleHandleW(None)
            wc.lpszClassName = _class_name
            if not user32.RegisterClassW(ctypes.byref(wc)):
                logger.warning("RegisterClassW failed, err={}", ctypes.get_last_error())
                return

            self._hwnd = user32.CreateWindowExW(
                0, _class_name, "", 0,
                0, 0, 0, 0, None, None, wc.hInstance, None,
            )
            if not self._hwnd:
                logger.warning("CreateWindowExW failed, err={}", ctypes.get_last_error())
                return

            if not wtsapi32.WTSRegisterSessionNotification(self._hwnd, NOTIFY_FOR_THIS_SESSION):
                logger.warning("WTSRegisterSessionNotification failed, err={}", ctypes.get_last_error())
                return

            msg = wintypes.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        except Exception as e:
            logger.warning("Session watcher loop error: {}", e)
        finally:
            self._cleanup()

    def _cleanup(self):
        if self._hwnd:
            wtsapi32.WTSUnRegisterSessionNotification(self._hwnd)
            user32.DestroyWindow(self._hwnd)
            self._hwnd = None

    def _proc(self, hwnd, msg, wparam, lparam):
        if msg == WM_WTSSESSION_CHANGE:
            try:
                if wparam == WTS_SESSION_LOCK:
                    logger.info("Session locked")
                    if self._on_lock:
                        self._on_lock()
                elif wparam == WTS_SESSION_UNLOCK:
                    logger.info("Session unlocked")
                    if self._on_unlock:
                        self._on_unlock()
            except Exception as e:
                logger.warning("Session change handler error: {}", e)
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)
