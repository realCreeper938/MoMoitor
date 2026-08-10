"""显示器亮度调节 —— 多策略实现（Windows ctypes / PowerShell）。

策略（按优先级）:
1. PowerShell + WMI（笔记本内置面板 —— 最可靠，无依赖）
2. \\\\.\\LCD 上的 IOCTL（内核级笔记本亮度）
3. dxva2.dll 的 DDC/CI（外接显示器）
"""

import ctypes
import ctypes.wintypes

from loguru import logger


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
    from momoitor.common import run_hidden

    try:
        # 查询当前亮度
        ps_get = (
            "(Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightness "
            "-ErrorAction Stop).CurrentBrightness"
        )
        r = run_hidden(
            ["powershell", "-NoProfile", "-Command", ps_get],
            timeout=5, text=True,
        )
        if r.returncode != 0 or not r.stdout.strip():
            logger.warning("WMI brightness get failed: rc={} stderr={}", r.returncode, r.stderr.strip())
            return {"success": False, "error": f"WMI query failed: {r.stderr.strip() or 'empty'}"}
        cur = int(r.stdout.strip())

        def do_set(target):
            ps_set = (
                f"(Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightnessMethods "
                f"-ErrorAction Stop).WmiSetBrightness(1,{target})"
            )
            r = run_hidden(
                ["powershell", "-NoProfile", "-Command", ps_set],
                timeout=5, text=True,
            )
            if r.returncode != 0:
                logger.warning("WMI brightness set failed: rc={} stderr={}", r.returncode, r.stderr.strip())
                return {"success": False, "error": f"WMI set failed: {r.stderr.strip()}"}
            logger.info("Brightness (WMI): {}% -> {}%", cur, target)
            return {"success": True, "level": target}

        return _brightness_apply(action, cur, level, do_set)
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

        def do_set(target):
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

        return _brightness_apply(action, int(cur), level, do_set)
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _brightness_apply(action, cur, level, do_set):
    """共享骨架：'get' 返回当前亮度，否则计算目标并经 do_set(target) 写入。

    do_set 返回 dict（成功/失败结果）或 None（策略不适用，交给上层回退）。
    """
    if action == "get":
        return {"success": True, "level": int(cur)}
    target = _compute_brightness_target(action, cur, level)
    if target is None:
        return {"success": False, "error": f"Unknown action: {action}"}
    return do_set(target)


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

                        def do_set(target):
                            target_raw = int(mn.value + span * target / 100)
                            if dxva2.SetMonitorBrightness(hPhysical, target_raw):
                                logger.info("Brightness (DDC/CI): {}% -> {}% (monitor {})", cur_pct, target, monitor_index)
                                return {"success": True, "level": target}
                            logger.warning("DDC/CI SetMonitorBrightness returned False")
                            return None

                        result = _brightness_apply(action, cur_pct, level, do_set)
                        if result is not None:
                            return result
                    else:
                        logger.debug("DDC/CI GetMonitorBrightness returned False")
                finally:
                    _close_physical_monitor(hPhysical)
    except Exception as e:
        logger.debug("DDC/CI brightness exception: {}", e)

    return {"success": False, "error": "All brightness methods failed (WMI, IOCTL, DDC/CI)"}