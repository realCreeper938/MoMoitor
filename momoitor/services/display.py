"""显示器枚举 —— 获取所有显示器的物理坐标与友好名称。

主要方法:
- get_monitors(): 获取所有显示器的物理像素坐标列表（含友好设备名）
"""

import ctypes
import ctypes.wintypes


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
        """通过设备路径（\\\\.\\DISPLAY1）查询友好的显示器型号名。"""
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