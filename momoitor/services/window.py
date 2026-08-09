"""窗口与系统空闲时间管理（Windows ctypes）。"""

import ctypes
import ctypes.wintypes
import time

from loguru import logger


def _get_hwnd(window) -> int:
    """从 pywebview 窗口获取 HWND。"""
    try:
        import win32gui

        def _enum(hwnd, result):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                if "MoMoitor" in title or "pywebview" in title:
                    result.append(hwnd)

        hwnds = []
        win32gui.EnumWindows(_enum, hwnds)
        if hwnds:
            return hwnds[0]
    except ImportError:
        pass
    return ctypes.windll.user32.GetForegroundWindow()


def _resolve_hwnd(window) -> int:
    """从窗口对象解析 HWND，依次尝试多个属性。"""
    for attr in ("native_handle", "_hwnd", "handle"):
        try:
            h = getattr(window, attr, None)
            if h:
                return int(h)
        except Exception:
            pass
    return _get_hwnd(window)


def minimize(window):
    """最小化窗口。"""
    try:
        window.minimize()
    except Exception as e:
        logger.warning("Failed to minimize window: {}", e)


def set_caption(window, enabled: bool):
    """为无边框窗口添加或移除 WS_CAPTION（标题栏）。"""
    hwnd = _resolve_hwnd(window)
    if not hwnd:
        return

    GWL_STYLE = -16
    WS_CAPTION = 0x00C00000
    WS_THICKFRAME = 0x00040000

    style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_STYLE)
    if enabled:
        style |= WS_CAPTION | WS_THICKFRAME
    else:
        style &= ~(WS_CAPTION | WS_THICKFRAME)
    ctypes.windll.user32.SetWindowLongW(hwnd, GWL_STYLE, style)

    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_NOZORDER = 0x0004
    SWP_FRAMECHANGED = 0x0020
    ctypes.windll.user32.SetWindowPos(
        hwnd, 0, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED
    )


def move_to_monitor(window, index: int) -> bool:
    """移动并调整窗口到目标显示器，失败时最多重试 3 次。"""
    monitors = get_monitors()
    if not (0 <= index < len(monitors)):
        logger.debug("Monitor index {} out of range ({} monitors), falling back to monitor 0", index, len(monitors))
        index = 0
        if not monitors:
            logger.warning("No monitors available")
            return False

    m = monitors[index]

    hwnd = _resolve_hwnd(window)
    if not hwnd:
        logger.warning("Could not get HWND for monitor move")
        return False

    hwnd = int(hwnd)

    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    SWP_SHOWWINDOW = 0x0040
    flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW

    for attempt in range(4):
        result = ctypes.windll.user32.SetWindowPos(
            hwnd, 0, m["x"], m["y"], m["width"], m["height"], flags
        )
        if result:
            logger.info("Window -> monitor {}: {}x{} at ({},{})", index + 1, m["width"], m["height"], m["x"], m["y"])
            return True
        err = ctypes.windll.kernel32.GetLastError()
        if err == 5 and attempt < 3:
            logger.debug("SetWindowPos attempt {} failed (err=5), retrying...", attempt + 1)
            time.sleep(0.5 * (attempt + 1))
        else:
            logger.warning("SetWindowPos failed, err={}", err)
            return False
    return False


def get_idle_time() -> float:
    """通过 Windows API 获取系统空闲时间（秒）。"""
    try:
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", ctypes.wintypes.UINT),
                ("dwTime", ctypes.wintypes.DWORD),
            ]

        lii = LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):
            # GetTickCount 返回 DWORD（无符号 32 位）；设置 restype 以避免
            # 有符号解释在约 24.8 天后导致空闲时间为负
            ctypes.windll.kernel32.GetTickCount.restype = ctypes.wintypes.DWORD
            millis = ctypes.windll.kernel32.GetTickCount() - lii.dwTime
            return millis / 1000.0
    except Exception as e:
        logger.debug("get_idle_time failed: {}", e)
    return 0.0


def get_monitors() -> list:
    """获取所有显示器的物理像素坐标列表（含友好设备名）。"""
    monitors = []

    class MONITORINFOEXW(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.wintypes.DWORD),
            ("rcMonitor", ctypes.wintypes.RECT),
            ("rcWork", ctypes.wintypes.RECT),
            ("dwFlags", ctypes.wintypes.DWORD),
            ("szDevice", ctypes.wintypes.WCHAR * 32),
        ]

    class DISPLAY_DEVICE(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.wintypes.DWORD),
            ("DeviceName", ctypes.wintypes.WCHAR * 32),
            ("DeviceString", ctypes.wintypes.WCHAR * 128),
            ("StateFlags", ctypes.wintypes.DWORD),
            ("DeviceID", ctypes.wintypes.WCHAR * 128),
            ("DeviceKey", ctypes.wintypes.WCHAR * 128),
        ]

    def _device_name(device: str) -> str:
        """通过设备路径（\\\\.\\DISPLAY1）查询友好的显示器型号名称。"""
        dd = DISPLAY_DEVICE()
        dd.cb = ctypes.sizeof(DISPLAY_DEVICE)
        if ctypes.windll.user32.EnumDisplayDevicesW(device, 0, ctypes.byref(dd), 0):
            return dd.DeviceString.strip("\x00 ").strip()
        return ""

    def callback(hMonitor, hdcMonitor, lprcMonitor, dwData):
        mi = MONITORINFOEXW()
        mi.cbSize = ctypes.sizeof(MONITORINFOEXW)
        ctypes.windll.user32.GetMonitorInfoW(hMonitor, ctypes.byref(mi))
        r = mi.rcMonitor
        device = mi.szDevice.strip("\x00 ").strip()
        monitors.append({
            "x": r.left,
            "y": r.top,
            "width": r.right - r.left,
            "height": r.bottom - r.top,
            "name": _device_name(device) or "Monitor",
        })
        return True

    MONITORENUMPROC = ctypes.WINFUNCTYPE(
        ctypes.wintypes.BOOL,
        ctypes.wintypes.HMONITOR,
        ctypes.wintypes.HDC,
        ctypes.POINTER(ctypes.wintypes.RECT),
        ctypes.wintypes.LPARAM,
    )
    ctypes.windll.user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(callback), 0)
    return monitors