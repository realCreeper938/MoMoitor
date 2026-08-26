"""通过 RTSS（RivaTuner Statistics Server）共享内存追踪 FPS —— 仅限 Windows。"""

import threading
import ctypes
from ctypes import wintypes
import struct
from collections import deque
from loguru import logger

from momoitor.common import Poller

HISTORY_SIZE = 60

FILE_MAP_READ = 0x0004
SHARED_MEMORY_NAME = "RTSSSharedMemoryV2"

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
user32 = ctypes.WinDLL('user32', use_last_error=True)

kernel32.OpenFileMappingW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.OpenFileMappingW.restype = wintypes.HANDLE
kernel32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t]
kernel32.MapViewOfFile.restype = ctypes.c_void_p
kernel32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

_fps = 0
_frametime = 0.0
_process_name = ""
_history_fps = deque([0.0] * HISTORY_SIZE, maxlen=HISTORY_SIZE)
_lock = threading.Lock()


def get_current():
    with _lock:
        valid = [v for v in _history_fps if v > 0]
        low1 = 0.0
        avg_fps = 0.0
        p99_fps = 0.0
        if valid:
            sorted_v = sorted(valid)
            count = max(1, len(sorted_v) // 100)
            low1 = sum(sorted_v[:count]) / count
            avg_fps = sum(sorted_v) / len(sorted_v)
            p99_idx = min(len(sorted_v) - 1, max(0, int(len(sorted_v) * 0.99) - 1))
            p99_fps = sorted_v[p99_idx]
        return {
            "fps": _fps,
            "frametime": _frametime,
            "process": _process_name,
            "history_fps": list(_history_fps),
            "low1pct": low1,
            "avg_fps": avg_fps,
            "p99_fps": p99_fps,
        }


def _read_rtss():
    """从 RTSS 共享内存读取前台应用的 FPS。"""
    h_map = kernel32.OpenFileMappingW(FILE_MAP_READ, False, SHARED_MEMORY_NAME)
    if not h_map:
        return 0, 0.0, ""
    try:
        p_view = kernel32.MapViewOfFile(h_map, FILE_MAP_READ, 0, 0, 0)
        if not p_view:
            return 0, 0.0, ""
        try:
            header_data = ctypes.string_at(p_view, 64)
            sig_int = struct.unpack('<I', header_data[0:4])[0]
            sig = chr((sig_int >> 24) & 0xFF) + chr((sig_int >> 16) & 0xFF) + \
                  chr((sig_int >> 8) & 0xFF) + chr(sig_int & 0xFF)
            if sig != 'RTSS':
                return 0, 0.0, ""

            app_entry_size = struct.unpack('<I', header_data[8:12])[0]
            app_arr_offset = struct.unpack('<I', header_data[12:16])[0]
            app_arr_size = struct.unpack('<I', header_data[16:20])[0]

            fg_window = user32.GetForegroundWindow()
            fg_pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(fg_window, ctypes.byref(fg_pid))

            fps = 0
            ft = 0.0
            name = ""
            for i in range(app_arr_size):
                entry_offset = app_arr_offset + (i * app_entry_size)
                entry_data = ctypes.string_at(p_view + entry_offset, app_entry_size)
                app_pid = struct.unpack('<I', entry_data[0:4])[0]
                if app_pid == 0:
                    continue
                name_bytes = entry_data[4:264]
                app_name = name_bytes.split(b'\x00')[0].decode('utf-8', errors='ignore')
                if '\\' in app_name:
                    app_name = app_name.rsplit('\\', 1)[-1]
                t0 = struct.unpack('<I', entry_data[268:272])[0]
                t1 = struct.unpack('<I', entry_data[272:276])[0]
                frames = struct.unpack('<I', entry_data[276:280])[0]
                raw_ft = struct.unpack('<I', entry_data[280:284])[0]
                delta = t1 - t0
                app_fps = round((frames * 1000.0 / delta) if delta > 0 else 0)
                app_ft = raw_ft / 1000.0 if raw_ft > 0 else ((1000.0 / app_fps) if app_fps > 0 else 0.0)
                if app_pid == fg_pid.value:
                    fps = app_fps
                    ft = app_ft
                    name = app_name
                    break
                if fps == 0 and app_fps > 0:
                    fps = app_fps
                    ft = app_ft
                    name = app_name

            return fps, ft, name
        finally:
            kernel32.UnmapViewOfFile(p_view)
    except Exception as e:
        logger.debug("RTSS read: {}", e)
        return 0, 0.0, ""
    finally:
        kernel32.CloseHandle(h_map)


def _poll():
    global _fps, _frametime, _process_name
    try:
        fps, ft, name = _read_rtss()
        with _lock:
            _fps = fps
            _frametime = ft
            _process_name = name
            _history_fps.append(float(fps))
    except Exception:
        pass


_poller = Poller("rtss-fps", 1.0, _poll)


def start():
    fresh = not _poller.running()
    _poller.start()
    if fresh:
        logger.info("RTSS FPS tracking started")


def stop():
    _poller.stop()
