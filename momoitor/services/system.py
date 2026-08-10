"""系统信息服务 —— 时间、主机名、运行时长、空闲时间、进程与监听端口。"""

import ctypes
import os
import re
import socket
import time

import psutil
from loguru import logger

from momoitor.common import run_hidden
from momoitor.services import proclist

# 逻辑核心数不变，启动时缓存一次
_CPU_COUNT = psutil.cpu_count(logical=True) or 1

# sysinfo 缓存：hostname/IP/boot_time 几乎不变，避免每 60s 重复 DNS 查询
_SYSINFO_TTL = 600
_sysinfo_cache = {"hostname": None, "ip": None, "boot": None, "ts": 0.0}


def get_time() -> str:
    return time.strftime("%H:%M:%S")


def get_system_theme_mode() -> str:
    """返回 Windows 当前亮/暗模式（'light'/'dark'），读取注册表，失败按暗色处理。"""
    try:
        import winreg
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        ) as key:
            value, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
            return "light" if value else "dark"
    except (OSError, ImportError):
        return "dark"


def clean_memory(deep: bool = False) -> dict:
    """回收每个进程的工作集（EmptyWorkingSet）——经典的 Windows 内存清理技巧：
    页面移入备用列表并按需复用，报告的使用量下降而不影响运行中的进程。

    deep=True 时额外对每个进程调用 SetProcessWorkingSetSize(-1, -1)，
    更激进地刷新工作集（用于快速重复点击）。
    返回 {"ok", "trimmed", "freed_bytes", "deep"}。"""
    if os.name != "nt":
        return {"ok": False, "error": "Windows only"}
    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    before = psutil.virtual_memory().used
    trimmed = 0
    for pid in psutil.pids():
        if pid in (0, 4):  # Idle 与 System —— 无论如何都会拒绝访问
            continue
        # 访问权限: PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTAS
        handle = kernel32.OpenProcess(0x0400 | 0x0100, False, pid)
        if handle:
            try:
                if psapi.EmptyWorkingSet(handle):
                    trimmed += 1
                if deep:
                    kernel32.SetProcessWorkingSetSize(handle, ctypes.c_size_t(-1), ctypes.c_size_t(-1))
            finally:
                kernel32.CloseHandle(handle)
    after = psutil.virtual_memory().used
    return {
        "ok": True,
        "trimmed": trimmed,
        "freed_bytes": max(0, before - after),
        "deep": deep,
    }


def get_sysinfo() -> dict:
    now = time.monotonic()
    if _sysinfo_cache["boot"] is None or now - _sysinfo_cache["ts"] > _SYSINFO_TTL:
        try:
            _sysinfo_cache["hostname"] = socket.gethostname()
            _sysinfo_cache["ip"] = socket.gethostbyname(_sysinfo_cache["hostname"])
            _sysinfo_cache["boot"] = psutil.boot_time()
            _sysinfo_cache["ts"] = now
        except Exception as e:
            logger.warning("get_sysinfo refresh failed: {}", e)
    elapsed = int(time.time() - (_sysinfo_cache["boot"] or time.time()))
    days, rem = divmod(elapsed, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    parts = []
    if days > 0:
        parts.append(f"{days}d")
    parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    parts.append(f"{secs}s")
    return {
        "hostname": _sysinfo_cache["hostname"] or "localhost",
        "ip": _sysinfo_cache["ip"] or "0.0.0.0",
        "uptime": " ".join(parts),
    }


def get_top_processes(sort_by: str = "cpu", limit: int = 1) -> list:
    """获取占用 CPU 或内存最高的进程。

    sort_by: 'cpu' 或 'mem'。
    返回 [{"pid": int, "name": str, "cpu": float, "mem": float, "mem_mb": float}, ...]
    自动排除 System Idle Process / 系统空闲进程。
    CPU 百分比按逻辑核心数归一化，与 Windows 任务管理器一致（单核满载≈100%/N，全核满载可达100%）。

    Windows 下优先走 proclist 的 NtQuerySystemInformation 快速路径（单次快照，
    避免 psutil 每进程权限回退），失败时回退到 psutil.process_iter。
    """
    fast = proclist.get_top_processes(sort_by=sort_by, limit=limit)
    if fast is not None:
        return fast
    all_procs = _get_all_processes()
    key = "mem" if sort_by == "mem" else "cpu"
    all_procs.sort(key=lambda x: x.get(key, 0.0), reverse=True)
    return all_procs[:limit]


def _get_all_processes() -> list:
    """内部方法：获取所有进程列表。"""
    idle_names = {"system idle process", "系统空闲进程", "idle", "memcompression"}
    procs = []
    for p in psutil.process_iter(attrs=["pid", "name", "cpu_percent", "memory_percent", "memory_info"]):
        try:
            info = p.info
            name = info.get("name") or "unknown"
            if name.lower() in idle_names:
                continue
            mem_mb = 0.0
            if info.get("memory_info"):
                mem_mb = info["memory_info"].rss / (1024 * 1024)
            procs.append({
                "pid": info["pid"],
                "name": name,
                "cpu": round(float(info.get("cpu_percent") or 0.0) / _CPU_COUNT, 1),
                "mem": float(info.get("memory_percent") or 0.0),
                "mem_mb": round(mem_mb, 1),
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    return procs


def kill_process(pid: int) -> dict:
    """终止指定 PID 的进程。返回 {"success": bool, "message": str}。"""
    try:
        p = psutil.Process(pid)
        name = p.name()
        p.terminate()
        try:
            p.wait(timeout=3)
        except psutil.TimeoutExpired:
            p.kill()
            p.wait(timeout=3)
        logger.info("Killed process {} ({})", pid, name)
        return {"success": True, "message": f"已终止 {name} (PID {pid})"}
    except psutil.NoSuchProcess:
        return {"success": False, "message": f"进程 {pid} 不存在"}
    except psutil.AccessDenied:
        return {"success": False, "message": f"拒绝访问 PID {pid}（需要管理员权限）"}
    except Exception as e:
        logger.exception("kill_process failed for {}: {}", pid, e)
        return {"success": False, "message": f"终止失败: {e}"}


def scan_listening_ports() -> list:
    """扫描所有监听端口（含仅监听本机的），包括 TCP 和 UDP，返回详细信息。

    使用 netstat -ano 获取端口列表，返回每个端口的 PID、进程名、地址、端口、协议。
    返回:
    [{"pid": int, "name": str, "address": str, "port": int, "protocol": str}, ...]
    """
    try:
        result = run_hidden(["netstat", "-ano"], timeout=10)
        # 尝试多种编码解码 netstat 输出
        raw = result.stdout
        text = None
        for enc in ["utf-8", "gbk", "cp936"]:
            try:
                text = raw.decode(enc)
                break
            except (UnicodeDecodeError, LookupError):
                continue
        if text is None:
            text = raw.decode("utf-8", errors="replace")
        # 解析 netstat 输出行
        # 格式:  TCP    0.0.0.0:PORT    0.0.0.0:0    LISTENING    PID
        # 格式:  UDP    0.0.0.0:PORT    *:*    PID
        # 也匹配 IPv6: [::]:PORT
        entries = []
        for line in text.splitlines():
            line = line.strip()
            # TCP 监听 —— 0.0.0.0 / [::]（所有接口）以及 127.0.0.1 / [::1]（仅本机）
            m = re.match(r"^\s*TCP\s+(0\.0\.0\.0|127\.0\.0\.1|\[::\]|\[::1\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$", line)
            if m:
                addr = m.group(1)
                port = int(m.group(2))
                pid = int(m.group(3))
                entries.append((pid, addr, port, "TCP"))
                continue
            # UDP 监听
            m = re.match(r"^\s*UDP\s+(0\.0\.0\.0|127\.0\.0\.1|\[::\]|\[::1\]):(\d+)\s+\S+\s+(\d+)\s*$", line)
            if m:
                addr = m.group(1)
                port = int(m.group(2))
                pid = int(m.group(3))
                entries.append((pid, addr, port, "UDP"))

        # 按 pid+port+protocol 去重
        seen = set()
        unique = []
        for pid, addr, port, proto in entries:
            key = (pid, port, proto)
            if key not in seen:
                seen.add(key)
                unique.append((pid, addr, port, proto))

        # 获取进程名
        result_list = []
        for pid, addr, port, proto in unique:
            name = "SYSTEM"
            try:
                proc = psutil.Process(pid)
                name = proc.name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            result_list.append({
                "pid": pid,
                "name": name,
                "address": addr,
                "port": port,
                "protocol": proto,
            })
        # 按端口号排序
        result_list.sort(key=lambda x: x["port"])
        return result_list
    except Exception as e:
        logger.warning("scan_listening_ports failed: {}", e)
        return []
