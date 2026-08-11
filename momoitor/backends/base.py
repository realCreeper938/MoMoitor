"""硬件监视后端的抽象基类：统一硬件采集接口与网络速率计算。"""

import abc
import ctypes
import sys
import time
from ctypes import wintypes

import psutil


class _MIB_IF_ROW2(ctypes.Structure):
    _fields_ = [
        ("InterfaceLuid", ctypes.c_uint64), ("InterfaceIndex", ctypes.c_uint32),
        ("InterfaceGuid", ctypes.c_ubyte * 16),
        ("Alias", wintypes.WCHAR * 257), ("Description", wintypes.WCHAR * 257),
        ("PhysicalAddressLength", ctypes.c_uint32), ("PhysicalAddress", ctypes.c_ubyte * 32),
        ("PermanentPhysicalAddress", ctypes.c_ubyte * 32),
        ("Mtu", ctypes.c_uint32), ("Type", ctypes.c_uint32), ("TunnelType", ctypes.c_uint32),
        ("MediaType", ctypes.c_uint32), ("PhysicalMediumType", ctypes.c_uint32),
        ("AccessType", ctypes.c_uint32), ("DirectionType", ctypes.c_uint32),
        ("InterfaceAndOperStatusFlags", ctypes.c_ubyte), ("OperStatus", ctypes.c_uint32),
        ("AdminStatus", ctypes.c_uint32), ("MediaConnectState", ctypes.c_uint32),
        ("NetworkGuid", ctypes.c_ubyte * 16), ("ConnectionType", ctypes.c_uint32),
        ("TransmitLinkSpeed", ctypes.c_uint64), ("ReceiveLinkSpeed", ctypes.c_uint64),
        ("InOctets", ctypes.c_uint64), ("InUcastPkts", ctypes.c_uint64), ("InNUcastPkts", ctypes.c_uint64),
        ("InDiscards", ctypes.c_uint64), ("InErrors", ctypes.c_uint64), ("InUnknownProtos", ctypes.c_uint64),
        ("InUcastOctets", ctypes.c_uint64), ("InMulticastOctets", ctypes.c_uint64), ("InBroadcastOctets", ctypes.c_uint64),
        ("OutOctets", ctypes.c_uint64), ("OutUcastPkts", ctypes.c_uint64), ("OutNUcastPkts", ctypes.c_uint64),
        ("OutDiscards", ctypes.c_uint64), ("OutErrors", ctypes.c_uint64), ("OutUcastOctets", ctypes.c_uint64),
        ("OutMulticastOctets", ctypes.c_uint64), ("OutBroadcastOctets", ctypes.c_uint64), ("OutQLen", ctypes.c_uint64),
    ]


class _MIB_IF_TABLE2(ctypes.Structure):
    _fields_ = [("NumEntries", ctypes.c_uint32), ("Table", _MIB_IF_ROW2 * 1)]


class _SOCKET_ADDRESS(ctypes.Structure):
    _fields_ = [("lpSockaddr", ctypes.c_void_p), ("iSockaddrLength", ctypes.c_int)]


class _IP_ADAPTER_ADDRESSES(ctypes.Structure):
    pass


_IP_ADAPTER_ADDRESSES._fields_ = [
    ("Length", ctypes.c_ulong),
    ("IfIndex", ctypes.c_uint32),
    ("Next", ctypes.POINTER(_IP_ADAPTER_ADDRESSES)),
    ("AdapterName", ctypes.c_char_p),
    ("FirstUnicastAddress", ctypes.POINTER(_SOCKET_ADDRESS)),
    ("FirstAnycastAddress", ctypes.POINTER(_SOCKET_ADDRESS)),
    ("FirstMulticastAddress", ctypes.POINTER(_SOCKET_ADDRESS)),
    ("FirstDnsServerAddress", ctypes.POINTER(_SOCKET_ADDRESS)),
    ("DnsSuffix", ctypes.c_wchar_p),
    ("Description", ctypes.c_wchar_p),
    ("FriendlyName", ctypes.c_wchar_p),
    ("PhysicalAddress", ctypes.c_ubyte * 8),
    ("PhysicalAddressLength", ctypes.c_uint32),
    ("Flags", ctypes.c_uint32),
    ("Mtu", ctypes.c_uint32),
    ("IfType", ctypes.c_uint32),
    ("OperStatus", ctypes.c_int),
    ("Ipv6IfIndex", ctypes.c_uint32),
    ("ZoneIndices", ctypes.c_uint32 * 16),
    ("FirstPrefix", ctypes.c_void_p),
    ("TransmitLinkSpeed", ctypes.c_uint64),
    ("ReceiveLinkSpeed", ctypes.c_uint64),
    ("FirstWinsServerAddress", ctypes.POINTER(_SOCKET_ADDRESS)),
    ("FirstGatewayAddress", ctypes.POINTER(_SOCKET_ADDRESS)),
    ("Ipv4Metric", ctypes.c_uint32),
    ("Ipv6Metric", ctypes.c_uint32),
    ("Luid", ctypes.c_uint64),
    ("Dhcpv4Server", _SOCKET_ADDRESS),
    ("CompartmentId", ctypes.c_uint32),
    ("NetworkGuid", ctypes.c_ubyte * 16),
    ("ConnectionType", ctypes.c_uint32),
    ("TunnelType", ctypes.c_uint32),
    ("Dhcpv6Server", _SOCKET_ADDRESS),
    ("Dhcpv6ClientDuid", ctypes.c_ubyte * 130),
    ("Dhcpv6ClientDuidLength", ctypes.c_uint32),
    ("Dhcpv6Iaid", ctypes.c_uint32),
    ("FirstDnsSuffix", ctypes.POINTER(_SOCKET_ADDRESS)),
]

_GAA_FLAGS = 0x0001 | 0x0002 | 0x0004 | 0x0008  # SKIP_UNICAST|ANYCAST|MULTICAST|DNS_SERVER
_NET_PLAN_TTL = 30.0

_iphlpapi = None


def _init_iphlpapi():
    global _iphlpapi
    if _iphlpapi is None:
        dll = ctypes.WinDLL("iphlpapi", use_last_error=True)
        dll.GetIfTable2.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        dll.GetIfTable2.restype = ctypes.c_ulong
        dll.FreeMibTable.argtypes = [ctypes.c_void_p]
        dll.FreeMibTable.restype = None
        dll.GetAdaptersAddresses.argtypes = [
            ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
            ctypes.POINTER(_IP_ADAPTER_ADDRESSES), ctypes.POINTER(ctypes.c_ulong),
        ]
        dll.GetAdaptersAddresses.restype = ctypes.c_ulong
        _iphlpapi = dll
    return _iphlpapi


def _get_if_rows(dll):
    """读取全部网卡计数行，返回 [(InterfaceIndex, OutOctets, InOctets), ...]。"""
    table_ptr = ctypes.c_void_p()
    if dll.GetIfTable2(ctypes.byref(table_ptr)) != 0 or not table_ptr.value:
        return None
    try:
        tbl = ctypes.cast(table_ptr.value, ctypes.POINTER(_MIB_IF_TABLE2)).contents
        rows = ctypes.cast(ctypes.byref(tbl.Table), ctypes.POINTER(_MIB_IF_ROW2))
        return [
            (rows[i].InterfaceIndex, rows[i].OutOctets, rows[i].InOctets)
            for i in range(tbl.NumEntries)
        ]
    finally:
        dll.FreeMibTable(table_ptr)


def _get_adapter_plan(dll):
    """用 GetAdaptersAddresses 获取真实适配器的 IfIndex -> FriendlyName 集合。"""
    size = ctypes.c_ulong(15 * 1024)
    buf = ctypes.cast(
        ctypes.create_string_buffer(size.value), ctypes.POINTER(_IP_ADAPTER_ADDRESSES)
    )
    r = dll.GetAdaptersAddresses(0, _GAA_FLAGS, None, buf, ctypes.byref(size))
    if r == 111:  # ERROR_BUFFER_OVERFLOW
        buf = ctypes.cast(
            ctypes.create_string_buffer(size.value), ctypes.POINTER(_IP_ADAPTER_ADDRESSES)
        )
        r = dll.GetAdaptersAddresses(0, _GAA_FLAGS, None, buf, ctypes.byref(size))
    if r != 0:
        return None
    plan = {}
    p = buf
    while p:
        a = p.contents
        fn = a.FriendlyName or ""
        if fn:
            plan[a.Ipv6IfIndex or a.IfIndex] = fn
        p = a.Next
    return plan


def _net_counters_fast():
    """快速读取网络累计字节数 (bytes_sent, bytes_recv)；失败返回 None。

    低频（30s）用 GetAdaptersAddresses 建立真实适配器 IfIndex 集合，
    热路径用 GetIfTable2 只累加集合内的行，结果与 psutil 一致但快约 8 倍。
    """
    if sys.platform != "win32":
        return None
    try:
        dll = _init_iphlpapi()
        now = time.monotonic()
        if now - _net_counters_fast._plan_ts >= _NET_PLAN_TTL:
            plan = _get_adapter_plan(dll)
            if plan:
                _net_counters_fast._plan = plan
                _net_counters_fast._plan_ts = now
        rows = _get_if_rows(dll)
        if not rows or not _net_counters_fast._plan:
            return None
        up = down = 0
        for idx, out, inn in rows:
            if idx in _net_counters_fast._plan:
                up += out
                down += inn
        return up, down
    except Exception:
        return None


_net_counters_fast._plan = None
_net_counters_fast._plan_ts = 0.0


class BaseMonitor(abc.ABC):
    def __init__(self):
        prev = _net_counters_fast()
        if prev is None:
            p = psutil.net_io_counters()
            prev = (p.bytes_sent, p.bytes_recv)
        self._prev_net = prev
        self._prev_net_time = time.monotonic()
        self._net_name = "LAN"
        self._net_name_ts = 0
        self._disk_cache = []
        self._disk_cache_ts = 0

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
    def get_hw_names(self) -> dict:
        """返回 {cpu, gpu, mem, disk}。"""

    def get_hw_detail(self, gpu_index=None) -> dict:
        """返回 CPU、GPU、内存的详细硬件信息。"""
        return {"cpu": {}, "gpu": {}, "mem": {}}

    def get_network(self) -> dict:
        now = time.monotonic()
        curr = _net_counters_fast()
        if curr is None:
            p = psutil.net_io_counters()
            curr = (p.bytes_sent, p.bytes_recv)
        dt = max(now - self._prev_net_time, 0.1)
        up = (curr[0] - self._prev_net[0]) / dt
        down = (curr[1] - self._prev_net[1]) / dt
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

    def _get_disk_partitions(self):
        """遍历物理分区（10 秒缓存），返回 [{letter, used_gb, total_gb, percent}, ...]。"""
        now = time.monotonic()
        if now - self._disk_cache_ts < 10:
            return self._disk_cache
        self._disk_cache_ts = now
        result = []
        for part in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(part.mountpoint)
                result.append({
                    "letter": part.mountpoint.rstrip("\\"),
                    "used_gb": round(usage.used / 1073741824, 0),
                    "total_gb": round(usage.total / 1073741824, 0),
                    "percent": usage.percent,
                })
            except (PermissionError, OSError):
                continue
        self._disk_cache = result
        return result

