"""硬件监视后端的抽象基类。

主要方法:
- BaseMonitor类: 硬件监视器后端抽象基类
  - close(): 关闭监视器
  - get_cpu(): 获取CPU信息 {clock, temp, power, load, voltage}
  - get_gpu(index): 获取GPU信息 {temp, power, load, vram_used_gb, vram_total_gb, vram_temp}
  - get_memory(): 获取内存信息 {used_gb, total_gb, percent, temp, volt, clock}
  - get_disks(): 获取磁盘分区信息列表
  - get_disk_status(): 获取磁盘状态 {activity, temp, read, write}
  - get_hw_names(): 获取硬件名称 {cpu, gpu, mem, disk}
  - get_hw_detail(gpu_index): 获取详细硬件信息
  - get_network(): 获取网络流量信息 {up, down, name}
  - snapshot(gpu_index): 获取完整硬件数据快照

主要变量:
- BaseMonitor._prev_net: 上一次网络IO计数器
- BaseMonitor._prev_net_time: 上一次网络IO时间
- BaseMonitor._net_name: 网络接口名称缓存
- BaseMonitor._net_name_ts: 网络名称缓存时间戳
"""

import abc
import psutil
import time
from loguru import logger


class BaseMonitor(abc.ABC):
    def __init__(self):
        self._prev_net = psutil.net_io_counters()
        self._prev_net_time = time.monotonic()
        self._net_name = "LAN"
        self._net_name_ts = 0

    def close(self):
        pass

    def get_backend_info(self) -> dict:
        """后端名称 + 版本（关于页显示）。子类覆写返回实际版本。"""
        return {"name": self.__class__.__name__, "version": None}

    @staticmethod
    def _run_wmic(args, timeout=3):
        """运行 WMIC 命令并返回解码后的 stdout；失败时返回空字符串。"""
        import subprocess
        try:
            return subprocess.check_output(
                ["wmic"] + args,
                timeout=timeout, stderr=subprocess.DEVNULL
            ).decode("utf-8", errors="ignore")
        except Exception:
            return ""

    @staticmethod
    def _run_powershell(script, timeout=5):
        """运行 PowerShell 命令并返回解码后的 stdout；失败时返回空字符串。"""
        from momoitor.common import run_hidden
        try:
            r = run_hidden(
                ["powershell", "-NoProfile", "-Command", script],
                timeout=timeout, text=True,
            )
            return r.stdout.strip() if r.returncode == 0 else ""
        except Exception:
            return ""

    @abc.abstractmethod
    def get_cpu(self) -> dict:
        """返回 {clock, temp, power, load, voltage}。"""

    @abc.abstractmethod
    def get_gpu(self, index=None) -> dict:
        """返回 {temp, power, load, vram_used_gb, vram_total_gb, vram_temp}。"""

    @abc.abstractmethod
    def get_memory(self) -> dict:
        """返回 {used_gb, total_gb, percent, temp, volt, clock}。"""

    @abc.abstractmethod
    def get_disks(self) -> list:
        """返回 [{letter, used_gb, total_gb, percent}, ...]。"""

    @abc.abstractmethod
    def get_disk_status(self) -> dict:
        """返回 {activity, temp, read, write}。"""

    @abc.abstractmethod
    def get_hw_names(self) -> dict:
        """返回 {cpu, gpu, mem, disk}。"""

    def get_hw_detail(self, gpu_index=None) -> dict:
        """返回 CPU、GPU、内存的详细硬件信息。"""
        return {"cpu": {}, "gpu": {}, "mem": {}}

    def get_network(self) -> dict:
        now = time.monotonic()
        curr = psutil.net_io_counters()
        dt = max(now - self._prev_net_time, 0.1)
        up = (curr.bytes_sent - self._prev_net.bytes_sent) / dt
        down = (curr.bytes_recv - self._prev_net.bytes_recv) / dt
        self._prev_net = curr
        self._prev_net_time = now
        name = self._get_network_name()
        return {"up": round(up), "down": round(down), "name": name}

    def _get_network_name(self) -> str:
        now = time.monotonic()
        if now - self._net_name_ts < 30:
            return self._net_name
        self._net_name_ts = now
        iface = "LAN"
        try:
            counters = psutil.net_io_counters(pernic=True)
            stats = psutil.net_if_stats()
            addrs = psutil.net_if_addrs()
            candidates = []
            for name, stat in stats.items():
                if not stat.isup or name.lower().startswith(("loopback", "lo")):
                    continue
                if name not in counters or name not in addrs:
                    continue
                total = counters[name].bytes_sent + counters[name].bytes_recv
                candidates.append((total, name))
            if candidates:
                iface = max(candidates)[1]
        except Exception:
            pass
        # 通过 WMI 解析硬件适配器名称（ProductName）
        hw_name = self._resolve_net_hw_name(iface)
        self._net_name = hw_name or iface
        return self._net_name

    def _resolve_net_hw_name(self, iface: str) -> str:
        """通过 PowerShell 将系统接口名解析为其硬件适配器描述。"""
        if not iface or iface == "LAN":
            return ""
        # PowerShell: Get-NetAdapter（Windows 10/11）
        ps = (
            "Get-NetAdapter -Name '" + iface + "' "
            "-ErrorAction SilentlyContinue | "
            "Select-Object -ExpandProperty InterfaceDescription"
        )
        out = self._run_powershell(ps)
        if out and out.lower() not in ('', iface.lower()):
            return out
        # 回退：WMI（较旧 Windows）
        out = self._run_wmic([
            "nic", "where", f"NetConnectionID='{iface}'",
            "get", "ProductName", "/format:list"
        ])
        for line in out.splitlines():
            if line.startswith("ProductName="):
                val = line.split("=", 1)[1].strip()
                if val:
                    return val
        return ""

    def snapshot(self, gpu_index=None) -> dict:
        return {
            "cpu": self.get_cpu(),
            "gpu": self.get_gpu(gpu_index),
            "mem": self.get_memory(),
            "disks": self.get_disks(),
            "disk_status": self.get_disk_status(),
            "net": self.get_network(),
        }

