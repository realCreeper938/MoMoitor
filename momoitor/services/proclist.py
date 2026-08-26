"""进程快速枚举 —— 基于单次 NtQuerySystemInformation(SystemProcessInformation)。

psutil.process_iter() 在 Windows 上为每个进程读取 cpu_times/memory_info 时，
对无权限进程会回退到 cext.proc_info()，而每次回退都会重新调用一次
NtQuerySystemInformation 全系统快照（本机实测约 4ms/次），数百个进程累加后
get_top_processes 一次调用耗时约 683ms。这里改为单次调用解析全部进程
（实测 3-6ms），供 system.get_top_processes 优先使用。

仅支持 64 位 Windows（本应用只分发 x64）。SYSTEM_PROCESS_INFORMATION 的
pid/rss 字段偏移在部分 Windows 版本间不同，首次使用时做一次性布局探测，
探测失败返回 None，由调用方回退到 psutil 实现。
"""

import ctypes
import struct
import sys
import time
from ctypes import wintypes

import psutil
from loguru import logger

_IS_WINDOWS = sys.platform == "win32"

# 字段偏移（x64）：NextEntryOffset@0、UserTime@0x28、KernelTime@0x30、
# ImageName@0x38 在常见 Windows 版本间稳定；pid 与 rss 偏移见 _PID/_RSS_CANDIDATES。
_OFF_USER_TIME = 0x28
_OFF_KERNEL_TIME = 0x30
_OFF_IMG_LEN = 0x38
_OFF_IMG_BUF = 0x40
_MIN_ENTRY = 0x50

# pid / rss 候选偏移（x64）：新版 pid@0x50、rss@0x90，旧版在 0x4c 附近
_PID_CANDIDATES = (0x4C, 0x50)
_RSS_CANDIDATES = tuple(range(0x58, 0x140, 8))

# NtQuerySystemInformation(SystemProcessInformation) 信息类编号
_PROCESS_INFORMATION_CLASS = 5
_STATUS_INFO_LENGTH_MISMATCH = 0xC0000004
_MAX_BUFFER = 16 * 1024 * 1024

# 100ns 时钟刻度（psutil cpu_percent 即进程 CPU 时间占墙钟比例）
_NS100_PER_SEC = 10_000_000
_MB = 1024 * 1024

_CPU_COUNT = psutil.cpu_count(logical=True) or 1
_IDLE_NAMES = {"system idle process", "系统空闲进程", "idle", "memcompression"}

# 公共别名：system.py 等复用同一份常量，避免两处名单日后漂移
CPU_COUNT = _CPU_COUNT
IDLE_NAMES = frozenset(_IDLE_NAMES)

_ntdll = None
if _IS_WINDOWS:
    try:
        _ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
        _ntdll.NtQuerySystemInformation.restype = ctypes.c_long
        _ntdll.NtQuerySystemInformation.argtypes = [
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.ULONG,
            ctypes.POINTER(wintypes.ULONG),
        ]
    except OSError:
        _ntdll = None

# 跨轮 CPU% 双采样状态：{pid: (user+kernel 100ns, 墙钟秒)}
_prev_times: dict[int, tuple[int, float]] = {}
_total_mem: int | None = None
_layout_cache = {"probed": False, "value": None}


def _query_process_info():
    """单次获取系统进程信息缓冲区；解析期间需保持缓冲区存活。失败返回 None。"""
    if _ntdll is None:
        return None
    size = 256 * 1024
    while size <= _MAX_BUFFER:
        buf = ctypes.create_string_buffer(size)
        needed = wintypes.ULONG(0)
        status = _ntdll.NtQuerySystemInformation(
            _PROCESS_INFORMATION_CLASS, buf, size, ctypes.byref(needed)
        )
        if status == 0:
            return buf
        if (status & 0xFFFFFFFF) == _STATUS_INFO_LENGTH_MISMATCH:
            size *= 2
            continue
        logger.warning("NtQuerySystemInformation failed: 0x{:08X}", status & 0xFFFFFFFF)
        return None
    return None


def _parse_entries(raw: bytes, pid_off: int, rss_off: int):
    """遍历进程链表，返回 [(pid, name, user_100ns, kernel_100ns, rss)]。"""
    entries = []
    off = 0
    n = len(raw)
    while off + _MIN_ENTRY <= n:
        (next_off,) = struct.unpack_from("<I", raw, off)
        (user,) = struct.unpack_from("<q", raw, off + _OFF_USER_TIME)
        (kernel,) = struct.unpack_from("<q", raw, off + _OFF_KERNEL_TIME)
        (pid,) = struct.unpack_from("<Q", raw, off + pid_off)
        (rss,) = struct.unpack_from("<Q", raw, off + rss_off)
        (img_len,) = struct.unpack_from("<H", raw, off + _OFF_IMG_LEN)
        (img_ptr,) = struct.unpack_from("<Q", raw, off + _OFF_IMG_BUF)
        name = ""
        if img_len and img_ptr:
            try:
                name = ctypes.string_at(img_ptr, img_len).decode("utf-16-le", errors="replace")
            except (ValueError, TypeError):
                name = ""
        entries.append((pid, name, max(user, 0), max(kernel, 0), rss))
        if next_off == 0:
            break
        off += next_off
    return entries


def _probe_layout():
    """一次性探测 pid/rss 字段偏移，返回 (pid_off, rss_off)；失败返回 None。

    pid 用 psutil.pids()（同样基于该 API）作真值，取命中率最高的候选偏移；
    rss 用 2-3 个 psutil 可读进程的 memory_info().rss 作锚点，扫描候选窗口。
    """
    buf = _query_process_info()
    if buf is None:
        return None
    raw = buf.raw
    try:
        real_pids = set(psutil.pids())
    except Exception:
        return None
    pid_off, best_hit = None, 0
    for cand in _PID_CANDIDATES:
        pids = [e[0] for e in _parse_entries(raw, cand, 0x90)]
        hit = sum(1 for p in pids if p in real_pids)
        if hit > best_hit:
            best_hit, pid_off = hit, cand
    if pid_off is None or best_hit < max(1, len(real_pids) // 2):
        return None
    anchors = []
    for e in _parse_entries(raw, pid_off, 0x90):
        pid, name = e[0], e[1]
        if not name or pid in (0, 4):
            continue
        try:
            anchors.append((pid, psutil.Process(pid).memory_info().rss))
        except Exception:
            continue
        if len(anchors) >= 3:
            break
    if not anchors:
        return None
    for rss_off in _RSS_CANDIDATES:
        rss_by_pid = {e[0]: e[4] for e in _parse_entries(raw, pid_off, rss_off)}
        hits = sum(1 for pid, rss in anchors if rss_by_pid.get(pid, -1) == rss)
        if hits >= 2:
            return pid_off, rss_off
    return None


def _layout():
    """返回已探测的 (pid_off, rss_off)，未探测时探测一次；失败返回 None。"""
    if not _layout_cache["probed"]:
        _layout_cache["value"] = _probe_layout()
        _layout_cache["probed"] = True
        if _layout_cache["value"] is None:
            logger.warning("进程列表 NtQSI 布局探测失败，get_top_processes 回退 psutil 实现")
    return _layout_cache["value"]


def get_top_processes(sort_by: str = "cpu", limit: int = 1):
    """快速获取占用 CPU 或内存最高的进程（与 system.get_top_processes 同形状）。

    不可用（非 Windows / 布局探测失败 / 调用异常）时返回 None，由调用方回退
    psutil 实现。CPU 百分比按逻辑核心数归一化，与任务管理器一致；首轮无历史
    采样数据返回 0。
    """
    if not _IS_WINDOWS or _ntdll is None:
        return None
    global _total_mem
    layout = _layout()
    if layout is None:
        return None
    buf = _query_process_info()
    if buf is None:
        return None
    if _total_mem is None:
        try:
            _total_mem = psutil.virtual_memory().total or 1
        except Exception:
            _total_mem = 1
    now = time.monotonic()
    procs = []
    seen = set()
    for pid, name, user, kernel, rss in _parse_entries(buf.raw, *layout):
        if not name or name.lower() in _IDLE_NAMES:
            continue
        seen.add(pid)
        cpu = 0.0
        prev = _prev_times.get(pid)
        if prev is not None:
            cur = user + kernel
            elapsed = (now - prev[1]) * _NS100_PER_SEC
            if elapsed > 0:
                cpu = (cur - prev[0]) / elapsed * 100.0 / _CPU_COUNT
        procs.append({
            "pid": pid,
            "name": name,
            "cpu": round(cpu, 1),
            "mem": rss / _total_mem * 100.0,
            "mem_mb": round(rss / _MB, 1),
        })
        _prev_times[pid] = (user + kernel, now)
    # 清除已消失的进程，避免状态无限增长
    for pid in list(_prev_times):
        if pid not in seen:
            del _prev_times[pid]
    key = "mem" if sort_by == "mem" else "cpu"
    procs.sort(key=lambda x: x.get(key, 0.0), reverse=True)
    return procs[:limit]
