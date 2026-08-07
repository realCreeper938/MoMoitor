"""窗口与显示器管理工具（Windows ctypes）。

主要方法:
- get_monitors(): 获取所有显示器的物理像素坐标列表（含友好设备名）
- minimize(window): 最小化窗口
- set_caption(window, enabled): 添加或移除窗口标题栏
- move_to_monitor(window, index): 将窗口移动到指定显示器
- get_idle_time(): 获取系统空闲时间（秒）
- adjust_brightness(action, level, monitor_index): 调节显示器亮度
- adjust_volume(action, level): 调节系统音量
"""

import ctypes
import ctypes.wintypes
import time

from loguru import logger

try:
    from pycaw.pycaw import AudioUtilities
    _HAS_PYCAW = True
except ImportError:
    _HAS_PYCAW = False


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


# -- 显示器亮度（DDC/CI，通过 dxva2.dll）------------------------

class _PHYSICAL_MONITOR(ctypes.Structure):
    _fields_ = [
        ("hPhysicalMonitor", ctypes.wintypes.HANDLE),
        ("szPhysicalMonitorDescription", ctypes.wintypes.WCHAR * 128),
    ]


def _enum_hmonitors() -> list:
    """返回所有活动显示的 HMONITOR 句柄列表。"""
    handles = []

    def callback(hMonitor, hdcMonitor, lprcMonitor, dwData):
        handles.append(hMonitor)
        return True

    MONITORENUMPROC = ctypes.WINFUNCTYPE(
        ctypes.wintypes.BOOL,
        ctypes.wintypes.HMONITOR,
        ctypes.wintypes.HDC,
        ctypes.POINTER(ctypes.wintypes.RECT),
        ctypes.wintypes.LPARAM,
    )
    ctypes.windll.user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(callback), 0)
    return handles


def _open_physical_monitor(hmon) -> int:
    """获取 HMONITOR 对应的第一个物理显示器句柄。失败时返回 0。"""
    try:
        dxva2 = ctypes.windll.dxva2
        num = ctypes.wintypes.DWORD()
        if not dxva2.GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, ctypes.byref(num)):
            return 0
        if num.value == 0:
            return 0
        arr = (_PHYSICAL_MONITOR * num.value)()
        if not dxva2.GetPhysicalMonitorsFromHMONITOR(hmon, num.value, arr):
            return 0
        return arr[0].hPhysicalMonitor
    except Exception as e:
        logger.debug("open_physical_monitor failed: {}", e)
        return 0


def _close_physical_monitor(hPhysical) -> None:
    try:
        # DestroyPhysicalMonitors 需要数组；将单个句柄包装为数组。
        arr = (_PHYSICAL_MONITOR * 1)()
        arr[0].hPhysicalMonitor = hPhysical
        ctypes.windll.dxva2.DestroyPhysicalMonitors(1, arr)
    except Exception:
        pass


def _adjust_brightness_wmi(action: str, level: int = None) -> dict:
    """通过 PowerShell + WMI 调节笔记本亮度（无 pywin32 依赖）。

    使用 subprocess 调用：
      (Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightness).CurrentBrightness
      (Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, N)
    """
    import subprocess

    # 隐藏 PowerShell 控制台窗口
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 0  # SW_HIDE

    try:
        # 查询当前亮度
        ps_get = (
            "(Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightness "
            "-ErrorAction Stop).CurrentBrightness"
        )
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_get],
            capture_output=True, text=True, timeout=5,
            startupinfo=startupinfo,
        )
        if r.returncode != 0 or not r.stdout.strip():
            logger.warning("WMI brightness get failed: rc={} stderr={}", r.returncode, r.stderr.strip())
            return {"success": False, "error": f"WMI query failed: {r.stderr.strip() or 'empty'}"}
        cur = int(r.stdout.strip())

        if action == "get":
            return {"success": True, "level": cur}

        target = _compute_brightness_target(action, cur, level)
        if target is None:
            return {"success": False, "error": f"Unknown action: {action}"}

        ps_set = (
            f"(Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightnessMethods "
            f"-ErrorAction Stop).WmiSetBrightness(1,{target})"
        )
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_set],
            capture_output=True, text=True, timeout=5,
            startupinfo=startupinfo,
        )
        if r.returncode != 0:
            logger.warning("WMI brightness set failed: rc={} stderr={}", r.returncode, r.stderr.strip())
            return {"success": False, "error": f"WMI set failed: {r.stderr.strip()}"}

        logger.info("Brightness (WMI): {}% -> {}%", cur, target)
        return {"success": True, "level": target}
    except Exception as e:
        logger.error("WMI brightness exception: {}", e)
        return {"success": False, "error": str(e)}


class _DISPLAY_BRIGHTNESS(ctypes.Structure):
    """IOCTL_VIDEO_*_DISPLAY_BRIGHTNESS 的 DISPLAY_BRIGHTNESS 结构。"""
    _fields_ = [
        ("ucDisplayPolicy", ctypes.c_ubyte),  # 0=Both, 1=DC, 2=AC
        ("ucACBrightness", ctypes.c_ubyte),
        ("ucDCBrightness", ctypes.c_ubyte),
    ]


# \\.\LCD 设备（笔记本内置面板）的 IOCTL 代码
_IOCTL_VIDEO_QUERY_DISPLAY_BRIGHTNESS = 0x0023049C
_IOCTL_VIDEO_SET_DISPLAY_BRIGHTNESS = 0x00230498


def _adjust_brightness_ioctl(action: str, level: int = None) -> dict:
    """通过 \\\\.\\LCD 上的 DeviceIoControl 调节笔记本内置面板亮度。

    若 \\\\.\\LCD 不存在（台式机 / 仅有外接显示器）则返回 None。
    """
    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    FILE_SHARE_READ = 1
    FILE_SHARE_WRITE = 2
    OPEN_EXISTING = 3
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

    # CreateFileW 返回 HANDLE (void*)；设置 restype 使返回值在 32 位和
    # 64 位 Python 上都与 INVALID_HANDLE_VALUE 匹配。
    k32 = ctypes.windll.kernel32
    k32.CreateFileW.restype = ctypes.c_void_p

    # 依次尝试 \\.\LCD 和 \\.\LCD0
    handle = INVALID_HANDLE_VALUE
    for dev in (r"\\.\LCD", r"\\.\LCD0"):
        handle = k32.CreateFileW(
            dev,
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            0,
            None,
        )
        if handle != INVALID_HANDLE_VALUE and handle:
            break
    if handle == INVALID_HANDLE_VALUE or not handle:
        err = ctypes.windll.kernel32.GetLastError()
        logger.debug(r"IOCTL: \\.\LCD not available (err={})", err)
        return None  # Not a laptop / no internal LCD device

    try:
        bytes_returned = ctypes.wintypes.DWORD()
        db = _DISPLAY_BRIGHTNESS()
        ok = ctypes.windll.kernel32.DeviceIoControl(
            handle,
            _IOCTL_VIDEO_QUERY_DISPLAY_BRIGHTNESS,
            None, 0,
            ctypes.byref(db), ctypes.sizeof(db),
            ctypes.byref(bytes_returned), None,
        )
        if not ok:
            err = ctypes.windll.kernel32.GetLastError()
            logger.warning("IOCTL query brightness failed (err={})", err)
            return None  # Fall through to other methods

        cur = db.ucDCBrightness if db.ucDCBrightness else db.ucACBrightness

        if action == "get":
            logger.debug("IOCTL brightness get: {}%", cur)
            return {"success": True, "level": int(cur)}

        target = _compute_brightness_target(action, int(cur), level)
        if target is None:
            return {"success": False, "error": f"Unknown action: {action}"}

        db_set = _DISPLAY_BRIGHTNESS()
        db_set.ucDisplayPolicy = 0
        db_set.ucACBrightness = target
        db_set.ucDCBrightness = target

        ok = ctypes.windll.kernel32.DeviceIoControl(
            handle,
            _IOCTL_VIDEO_SET_DISPLAY_BRIGHTNESS,
            ctypes.byref(db_set), ctypes.sizeof(db_set),
            None, 0,
            ctypes.byref(bytes_returned), None,
        )
        if not ok:
            err = ctypes.windll.kernel32.GetLastError()
            logger.warning("IOCTL set brightness failed (err={})", err)
            return None  # Fall through

        logger.info("Brightness (IOCTL): {}% -> {}%", cur, target)
        return {"success": True, "level": target}
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _compute_brightness_target(action: str, cur: int, level: int = None) -> int:
    """根据动作与当前值计算目标亮度（0-100）。动作未知时返回 None。"""
    if action == "set" and level is not None:
        return max(0, min(100, int(level)))
    if action == "up":
        return min(100, cur + 10)
    if action == "down":
        return max(0, cur - 10)
    return None


def adjust_brightness(action: str, level: int = None, monitor_index: int = 0) -> dict:
    """调节显示器亮度。

    策略：
    1. 通过 PowerShell 的 WMI（笔记本内置面板 —— 最可靠，无依赖）
    2. \\\\.\\LCD 上的 IOCTL（内核级笔记本亮度）
    3. 通过 dxva2.dll 的 DDC/CI（外接显示器）

    action: 'get' 返回当前亮度，'set' (0-100)、'up' (+10)、'down' (-10)。
    """
    logger.info("adjust_brightness: action={} level={} monitor={}", action, level, monitor_index)

    # 1. 通过 PowerShell 的 WMI —— 笔记本最可靠，无需 pywin32
    wmi_result = _adjust_brightness_wmi(action, level)
    if wmi_result.get("success"):
        return wmi_result
    logger.debug("WMI brightness failed: {}", wmi_result.get("error"))

    # 2. \\.\LCD 上的 IOCTL
    ioctl_result = _adjust_brightness_ioctl(action, level)
    if ioctl_result is not None:
        if ioctl_result.get("success"):
            return ioctl_result
        logger.debug("IOCTL brightness failed: {}", ioctl_result.get("error"))

    # 3. 针对外接显示器的 DDC/CI
    try:
        dxva2 = ctypes.windll.dxva2
        handles = _enum_hmonitors()
        if handles:
            if monitor_index < 0 or monitor_index >= len(handles):
                monitor_index = 0
            hmon = handles[monitor_index]
            hPhysical = _open_physical_monitor(hmon)
            if hPhysical:
                try:
                    mn = ctypes.wintypes.DWORD()
                    cur = ctypes.wintypes.DWORD()
                    mx = ctypes.wintypes.DWORD()
                    if dxva2.GetMonitorBrightness(hPhysical, ctypes.byref(mn), ctypes.byref(cur), ctypes.byref(mx)):
                        span = max(1, mx.value - mn.value)
                        cur_pct = round((cur.value - mn.value) / span * 100)

                        if action == "get":
                            return {"success": True, "level": cur_pct}

                        target_pct = _compute_brightness_target(action, cur_pct, level)
                        if target_pct is None:
                            return {"success": False, "error": f"Unknown action: {action}"}

                        target_raw = int(mn.value + span * target_pct / 100)
                        if dxva2.SetMonitorBrightness(hPhysical, target_raw):
                            logger.info("Brightness (DDC/CI): {}% -> {}% (monitor {})", cur_pct, target_pct, monitor_index)
                            return {"success": True, "level": target_pct}
                        logger.warning("DDC/CI SetMonitorBrightness returned False")
                    else:
                        logger.debug("DDC/CI GetMonitorBrightness returned False")
                finally:
                    _close_physical_monitor(hPhysical)
    except Exception as e:
        logger.debug("DDC/CI brightness exception: {}", e)

    return {"success": False, "error": "All brightness methods failed (WMI, IOCTL, DDC/CI)"}


def adjust_volume(action: str, level: int = None) -> dict:
    """调节系统音量。action: 'set' (0-100)、'get'、'up'、'down'、'mute'、'unmute'。"""
    try:
        if not _HAS_PYCAW:
            return {"success": False, "error": "pycaw not installed"}
        devices = AudioUtilities.GetSpeakers()
        volume = devices.EndpointVolume

        if action == 'get':
            current = volume.GetMasterVolumeLevelScalar() * 100
            muted = volume.GetMute()
            return {"success": True, "level": round(current), "muted": bool(muted)}

        if action == 'set' and level is not None:
            level = max(0, min(100, level))
            volume.SetMasterVolumeLevelScalar(level / 100.0, None)
            return {"success": True, "level": level}

        if action == 'up':
            current = volume.GetMasterVolumeLevelScalar() * 100
            new_level = min(100, current + 5)
            volume.SetMasterVolumeLevelScalar(new_level / 100.0, None)
            return {"success": True, "level": round(new_level)}

        if action == 'down':
            current = volume.GetMasterVolumeLevelScalar() * 100
            new_level = max(0, current - 5)
            volume.SetMasterVolumeLevelScalar(new_level / 100.0, None)
            return {"success": True, "level": round(new_level)}

        if action == 'mute':
            volume.SetMute(True, None)
            return {"success": True, "muted": True}

        if action == 'unmute':
            volume.SetMute(False, None)
            return {"success": True, "muted": False}

        return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        logger.error("adjust_volume failed: {}", e)
        return {"success": False, "error": str(e)}
