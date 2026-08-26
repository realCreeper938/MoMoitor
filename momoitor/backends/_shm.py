"""共享内存读取基建 —— HWiNFO / AIDA64 后端共用的 WinAPI 文件映射封装。

ctypes.windll.kernel32 是进程级单例，argtypes/restype 在模块导入时声明一次；
此前 AIDA64 后端每次读取都重设绑定（每秒一次的无谓开销，多线程下还有竞态）。
"""

import ctypes
import ctypes.wintypes as wintypes

FILE_MAP_READ = 0x0004

_k32 = ctypes.windll.kernel32
_k32.OpenFileMappingW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
_k32.OpenFileMappingW.restype = wintypes.HANDLE
_k32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                               wintypes.DWORD, ctypes.c_size_t]
_k32.MapViewOfFile.restype = ctypes.c_void_p
_k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
_k32.UnmapViewOfFile.restype = wintypes.BOOL
_k32.CloseHandle.argtypes = [wintypes.HANDLE]
_k32.CloseHandle.restype = wintypes.BOOL


def open_mapping(name: str) -> int:
    """以只读方式打开命名文件映射；失败返回 0。"""
    return _k32.OpenFileMappingW(FILE_MAP_READ, False, name)


def map_view(handle: int) -> int:
    """映射整个文件视图（size=0），返回基地址；失败返回 0。"""
    return _k32.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0)


def unmap_view(addr: int) -> None:
    _k32.UnmapViewOfFile(addr)


def close_handle(handle: int) -> None:
    _k32.CloseHandle(handle)
