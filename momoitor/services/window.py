"""窗口与系统空闲时间管理（Windows ctypes）。"""

import ctypes
import ctypes.wintypes
import time

from loguru import logger


def _hwnd_from_native(window) -> int:
    """从 pywebview 原生窗口（window.native，WinForms Form）取 HWND。

    pywebview 在窗口创建后把原生窗口对象放到 window.native（详见官方 API 文档
    window.native），其 .Handle 即本程序窗口的 HWND。native 为 None 时（尚未显示）
    返回 0。

    注意：WinForms Form.Handle 是 System.IntPtr，`int(handle)` 会抛 TypeError，
    必须经 ToInt64() 转成整数，否则会退化为不可靠的按标题枚举窗口（见
    _find_window_by_title），在窗口刚显示时易失败、导致启动时透明度不生效。
    """
    try:
        native = getattr(window, "native", None)
        if native is not None:
            handle = getattr(native, "Handle", None)
            if handle:
                if hasattr(handle, "ToInt64"):
                    return int(handle.ToInt64())
                return int(handle)
    except Exception:
        pass
    return 0


def _find_window_by_title() -> int:
    """仅枚举标题含本程序特征名的窗口，取第一个；找不到返回 0。

    不依赖 win32gui；绝不返回无关窗口（避免误操作其它程序窗口）。
    """
    try:
        from ctypes import wintypes

        found = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def _cb(hwnd, lparam):
            length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
            if length:
                buf = ctypes.create_unicode_buffer(length + 1)
                if ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1):
                    title = buf.value
                    if "MoMoitor" in title or "pywebview" in title:
                        found.append(hwnd)
            return True

        ctypes.windll.user32.EnumWindows(_cb, 0)
        return int(found[0]) if found else 0
    except Exception:
        return 0


def _resolve_hwnd(window) -> int:
    """解析 pywebview 窗口的 HWND；找到返回句柄，否则返回 0。

    优先取 window.native 的原生句柄，其次按标题枚举本程序窗口。
    绝不用 GetForegroundWindow 兜底——那会拿到当前聚焦的任意窗口，把它误当作
    本程序窗口做移动/改样式等操作（例如把用户正在用的窗口或锁屏时钟挪到副屏）。
    """
    hwnd = _hwnd_from_native(window)
    if hwnd:
        return hwnd
    return _find_window_by_title()


def minimize(window):
    """最小化窗口。"""
    try:
        window.minimize()
    except Exception as e:
        logger.warning("Failed to minimize window: {}", e)


def focus_hwnd(hwnd) -> bool:
    """显示并激活指定 HWND（托盘左键 / 单实例聚焦共用）。最小化时先还原。

    SetForegroundWindow 受系统前台锁定限制（后台进程不得抢占前台），
    标准做法是临时把当前线程附加到前台窗口的输入队列以获得许可。
    """
    hwnd = int(hwnd)
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    SW_SHOW = 5
    SW_RESTORE = 9
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    else:
        user32.ShowWindow(hwnd, SW_SHOW)

    fg = user32.GetForegroundWindow()
    fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    cur_tid = kernel32.GetCurrentThreadId()
    attached = False
    if fg_tid and fg_tid != cur_tid:
        attached = user32.AttachThreadInput(fg_tid, cur_tid, True)
    try:
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(fg_tid, cur_tid, False)
    return True


def focus(window) -> bool:
    """显示并激活窗口（托盘左键）。最小化时先还原。"""
    hwnd = _resolve_hwnd(window)
    if not hwnd:
        logger.warning("Could not get HWND for window focus")
        return False
    return focus_hwnd(hwnd)


def is_visible(window) -> bool:
    """窗口当前是否可见（最小化仍算可见；无法判断时按可见处理）。"""
    hwnd = _resolve_hwnd(window)
    if not hwnd:
        return True
    return bool(ctypes.windll.user32.IsWindowVisible(int(hwnd)))


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


def set_opacity(window, opacity: int) -> bool:
    """设置原生窗口透明度（10-100）。"""
    hwnd = _resolve_hwnd(window)
    if not hwnd:
        logger.warning("Could not get HWND for opacity change")
        return False

    try:
        opacity = max(10, min(100, int(opacity)))
    except (TypeError, ValueError):
        opacity = 100
    GWL_EXSTYLE = -20
    WS_EX_LAYERED = 0x00080000
    LWA_ALPHA = 0x2
    style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    if not ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED):
        logger.warning("Could not enable layered window style")
        return False
    result = ctypes.windll.user32.SetLayeredWindowAttributes(
        hwnd, 0, round(opacity * 255 / 100), LWA_ALPHA
    )
    if not result:
        logger.warning("SetLayeredWindowAttributes failed, err={}", ctypes.windll.kernel32.GetLastError())
        return False
    return True


def set_on_top(window, enabled: bool) -> bool:
    """设置窗口是否始终置顶（HWND_TOPMOST / HWND_NOTOPMOST）。"""
    hwnd = _resolve_hwnd(window)
    if not hwnd:
        logger.warning("Could not get HWND for always-on-top toggle")
        return False

    SWP_NOMOVE = 0x0002
    SWP_NOSIZE = 0x0001
    SWP_NOACTIVATE = 0x0010
    HWND_TOPMOST = -1
    HWND_NOTOPMOST = -2
    insert_after = HWND_TOPMOST if enabled else HWND_NOTOPMOST

    result = ctypes.windll.user32.SetWindowPos(
        int(hwnd), insert_after, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    )
    if not result:
        logger.warning("SetWindowPos for on_top={} failed, err={}", enabled, ctypes.windll.kernel32.GetLastError())
        return False
    logger.debug("Window always-on-top = {}", enabled)
    return True


def move_to_monitor(window, target) -> bool:
    """移动并调整窗口到目标显示器，失败时最多重试 3 次。

    target 可以是显示器设备 ID / 设备路径字符串，或 legacy 序号 int。
    目标不在当前枚举中时会回退到主屏/首屏。
    """
    m, _ = find_display(target)
    if m is None:
        logger.warning("No monitors available")
        return False

    hwnd = _resolve_hwnd(window)
    if not hwnd:
        logger.warning("Could not get HWND for monitor move")
        return False

    hwnd = int(hwnd)

    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    SWP_SHOWWINDOW = 0x0040
    flags = SWP_NOZORDER | SWP_NOACTIVATE
    # 保持窗口原有可见性：SWP_SHOWWINDOW 会把隐藏窗口强行显示出来，
    # 「显示器缺少时隐藏」的窗口在移动时不应因此露出。
    if is_visible(window):
        flags |= SWP_SHOWWINDOW

    for attempt in range(4):
        result = ctypes.windll.user32.SetWindowPos(
            hwnd, 0, m["x"], m["y"], m["width"], m["height"], flags
        )
        if result:
            logger.info("Window -> monitor {}: {}x{} at ({},{})", m.get("name") or m.get("device") or m.get("id", ""), m["width"], m["height"], m["x"], m["y"])
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


def enum_display_monitors(callback) -> None:
    """枚举所有活动显示器，对每个 HMONITOR 句柄调用 callback(hmonitor)。

    封装 EnumDisplayMonitors 的 WINFUNCTYPE 回调样板，供本模块
    get_monitors 与 brightness 等服务复用。
    """
    MONITORENUMPROC = ctypes.WINFUNCTYPE(
        ctypes.wintypes.BOOL,
        ctypes.wintypes.HMONITOR,
        ctypes.wintypes.HDC,
        ctypes.POINTER(ctypes.wintypes.RECT),
        ctypes.wintypes.LPARAM,
    )

    def _cb(hmon, _hdc, _lprc, _dw):
        callback(hmon)
        return True

    ctypes.windll.user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(_cb), 0)


def get_monitors() -> list:
    """获取所有显示器的物理像素坐标列表（含友好设备名与稳定设备标识）。"""
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

    def _device_info(device: str) -> tuple:
        """通过设备路径（\\\\.\\DISPLAY1）查询友好的显示器型号名称与设备 ID。

        返回 (名称, 设备 ID)。设备 ID（如 DISPLAY\\DEL409E\\5&...）是这块屏的
        稳定标识，比枚举下标更能精确对应物理显示器。查询失败时返回空字符串。
        """
        dd = DISPLAY_DEVICE()
        dd.cb = ctypes.sizeof(DISPLAY_DEVICE)
        if ctypes.windll.user32.EnumDisplayDevicesW(device, 0, ctypes.byref(dd), 0):
            name = dd.DeviceString.strip("\x00 ").strip()
            dev_id = dd.DeviceID.strip("\x00 ").strip()
            return name, dev_id
        return "", ""

    MONITORINFOF_PRIMARY = 0x01

    def _collect(hmon):
        mi = MONITORINFOEXW()
        mi.cbSize = ctypes.sizeof(MONITORINFOEXW)
        ctypes.windll.user32.GetMonitorInfoW(hmon, ctypes.byref(mi))
        r = mi.rcMonitor
        w = mi.rcWork
        device = mi.szDevice.strip("\x00 ").strip()
        name, dev_id = _device_info(device)
        monitors.append({
            "x": r.left,
            "y": r.top,
            "width": r.right - r.left,
            "height": r.bottom - r.top,
            "work_x": w.left,
            "work_y": w.top,
            "work_width": w.right - w.left,
            "work_height": w.bottom - w.top,
            "name": name or "Monitor",
            "device": device,
            "id": dev_id,
            "primary": bool(mi.dwFlags & MONITORINFOF_PRIMARY),
        })

    enum_display_monitors(_collect)
    return monitors


def display_target(display: dict):
    """从 settings 的 display 分组提取目标显示器身份。

    优先使用 monitor_id（设备 ID 字符串，稳定），否则回退为 legacy 序号 monitor（int）。
    无偏好时返回 None（表示由系统回退到主屏/首屏）。
    """
    mid = display.get("monitor_id")
    # monitor_id 可能是历史遗留的哨兵值（如 "0"/""，表示未选择具体显示器），
    # 这类纯数字/空值不是真实设备偏好（真实设备 ID 形如 MONITOR\\... 或 \\.\DISPLAY1），
    # 直接忽略，回退用 legacy 序号。
    if mid and not str(mid).strip().isdigit():
        return mid
    monitor = display.get("monitor", 0)
    return monitor


def _primary_monitor(monitors: list) -> dict:
    """取主屏；无主屏标记时回退首屏。monitors 为空时返回 None。"""
    if not monitors:
        return None
    for m in monitors:
        if m.get("primary"):
            return m
    return monitors[0]


def find_display(target, monitors=None) -> tuple:
    """把目标显示器身份解析为当前枚举中的一块屏。

    - target: 目标身份（设备 ID / 设备路径字符串，或 legacy 序号 int，或 None）。
    - 返回 (monitor dict | None, matched)。
      - monitor_dict 为 None 表示系统没有任何显示器；
      - matched 为 True 表示精确命中目标（或无需精确匹配、有任一块屏即可）；
        matched 为 False 表示目标不在当前枚举中，已回退到主屏/首屏。
    """
    if monitors is None:
        monitors = get_monitors()
    if not monitors:
        return None, False
    if target is None:
        return _primary_monitor(monitors), True
    if isinstance(target, int):
        if 0 <= target < len(monitors):
            return monitors[target], True
        return _primary_monitor(monitors), False
    target = str(target).strip()
    for m in monitors:
        if m.get("id") == target or m.get("device") == target:
            return m, True
    return _primary_monitor(monitors), False
