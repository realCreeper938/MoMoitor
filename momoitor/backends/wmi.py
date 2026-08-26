"""基于 Windows Management Instrumentation (WMI) 的轻量硬件监视后端。

通过 pythonnet 加载 .NET System.Management 查询 WMI。相比 LHM / HWiNFO 的
传感器级数据，WMI 无法提供 CPU/GPU 温度、功耗、显存占用等字段，这些在返回
结构中保持为 None（前端显示 "N/A"）。作为无外部监视软件时的降级后端。

实现注意：对 ManagementObjectCollection 严禁使用 list()/len()（会触发 .NET
get_Count()，其异常无法被 Python 捕获并会崩溃进程）。统一用 for 循环迭代，
异常可在 try/except 中正常捕获。
"""

import time

import psutil
from loguru import logger

from .base import BaseMonitor, safe_int

# 静态硬件元数据（名称、规格）很少变化。
_META_TTL = 300

# 常见核显关键字（与 lhm._IGPU_KEYWORDS 语义一致，用于挑选独显）。
_IGPU_KEYWORDS = ("microsoft", "basic", "uhd", "iris", "radeon graphics", "vega", "intel")


# 常见核显关键字（与 lhm._IGPU_KEYWORDS 语义一致，用于挑选独显）。
_IGPU_KEYWORDS = ("microsoft", "basic", "uhd", "iris", "radeon graphics", "vega", "intel")

# 数值解析统一走 base 的安全转换（历史名 _parse_int 保留为别名）
_parse_int = safe_int


class WMIMonitor(BaseMonitor):
    def __init__(self):
        super().__init__()
        # 延迟初始化：首次访问时加载 System.Management 程序集（可能耗时）。
        self._searcher_fn = None
        self._initialized = False
        # 元数据缓存
        self._hw_names_cache = None
        self._hw_names_ts = 0
        self._cpu_detail_cache = None
        self._cpu_detail_ts = 0
        self._gpu_detail_cache = {}
        self._gpu_detail_ts = 0
        self._mem_detail_cache = None
        self._mem_detail_ts = 0
        self._mem_name_cache = None
        self._mem_name_ts = 0

    def _ensure_init(self):
        """首次访问时加载 .NET System.Management。线程安全。"""
        if self._initialized:
            return
        import threading
        with threading.Lock():
            if self._initialized:
                return
            import clr
            clr.AddReference("System.Management")
            from System.Management import ManagementObjectSearcher, ObjectQuery
            self._searcher_fn = lambda query: ManagementObjectSearcher(ObjectQuery(query))
            self._initialized = True
            logger.info("WMI backend initialized")

    def _query(self, query):
        """执行 WQL 查询，返回行字典列表；失败/异常返回 None。

        永远用 for 循环迭代集合（见模块 docstring），不要把集合传给
        list()/len()。
        """
        self._ensure_init()
        rows = []
        try:
            for mo in self._searcher_fn(query).Get():
                rows.append(mo)
        except BaseException as e:
            logger.debug("WMI query failed: {}", e)
            return None
        return rows

    def _first(self, query):
        """执行查询并返回第一行字典（str 值），无行/失败返回 None。"""
        rows = self._query(query)
        if not rows:
            return None
        mo = rows[0]
        out = {}
        for prop in mo.Properties:
            v = prop.Value
            out[prop.Name] = None if v is None else str(v).strip()
        return out

    def _wmi_val(self, mo, key, default=None):
        """安全读取一行 WMI 对象的某字段。"""
        if mo is None:
            return default
        try:
            v = mo[key]
            if v is None:
                return default
            return str(v).strip()
        except BaseException:
            return default

    def _get_cpu(self):
        """CPU 数据：负载来自性能计数器，时钟/规格来自 Win32_Processor。"""
        cpu = {"clock": None, "temp": None, "power": None, "load": None, "voltage": None}
        row = self._first(
            "SELECT PercentProcessorTime FROM Win32_PerfFormattedData_PerfOS_Processor "
            "WHERE Name=\"_Total\""
        )
        load = _parse_int(self._wmi_val(row, "PercentProcessorTime"))
        if load is None:
            # 回退：Win32_Processor.LoadPercentage（较粗略）
            proc = self._first(
                "SELECT CurrentClockSpeed, MaxClockSpeed, LoadPercentage FROM Win32_Processor"
            )
            load = _parse_int(self._wmi_val(proc, "LoadPercentage"))
            cpu["clock"] = _parse_int(self._wmi_val(proc, "CurrentClockSpeed"))
            if not cpu["clock"]:
                cpu["clock"] = _parse_int(self._wmi_val(proc, "MaxClockSpeed"))
        cpu["load"] = load
        return cpu

    def _get_mem(self):
        """内存：Win32_OperatingSystem 已用/总量（单位 KB）。"""
        row = self._first(
            "SELECT FreePhysicalMemory, TotalVisibleMemorySize FROM Win32_OperatingSystem"
        )
        total_kb = _parse_int(self._wmi_val(row, "TotalVisibleMemorySize"), 0)
        free_kb = _parse_int(self._wmi_val(row, "FreePhysicalMemory"), 0)
        if total_kb <= 0:
            vm = psutil.virtual_memory()
            return {
                "used_gb": round(vm.used / 1073741824, 1),
                "total_gb": round(vm.total / 1073741824, 1),
                "percent": vm.percent,
                "temp": None, "volt": None, "clock": None,
            }
        used_kb = max(total_kb - free_kb, 0)
        return {
            "used_gb": round(used_kb / 1048576, 1),
            "total_gb": round(total_kb / 1048576, 1),
            "percent": round(used_kb / total_kb * 100, 1),
            "temp": None, "volt": None, "clock": None,
        }

    def _get_gpu(self, gpu_index=None):
        """GPU 数据：名称/驱动来自 Win32_VideoController，实时利用率为空。"""
        gpu = {"temp": None, "power": None, "vram_used_gb": None, "vram_total_gb": None,
               "load": None, "vram_temp": None}
        adapters = self._query(
            "SELECT Name, AdapterRAM, DriverVersion FROM Win32_VideoController"
        )
        if not adapters:
            return gpu
        chosen = None
        if gpu_index is not None and 0 <= gpu_index < len(adapters):
            chosen = adapters[gpu_index]
        else:
            name_l = [self._wmi_val(a, "Name", "").lower() for a in adapters]
            scored = [
                (i, any(k in name_l[i] for k in _IGPU_KEYWORDS)) for i in range(len(adapters))
            ]
            discrete = [i for i, is_igpu in scored if not is_igpu]
            chosen = adapters[discrete[0]] if discrete else adapters[0]
        # Win32_VideoController 不暴露显存占用；AdapterRAM 是 uint32 会溢出，
        # 且与真实显存不一致，故 vram_total_gb 也留空。
        gpu["load"] = self._gpu_load()
        return gpu

    def _gpu_load(self):
        """GPU 利用率（性能计数器）。该 WMI 类在部分机器/驱动上不可用，返回 None。"""
        row = self._first(
            "SELECT UtilPercent FROM Win32_PerfFormattedData_GPUPerformanceCounters "
            "WHERE Name=\"Total\""
        )
        return _parse_int(self._wmi_val(row, "UtilPercent"))

    def _get_disk_status(self):
        """磁盘活动率（性能计数器 _Total）；温度/读写速率 WMI 不提供。"""
        row = self._first(
            "SELECT PercentDiskTime FROM Win32_PerfFormattedData_PerfDisk_LogicalDisk "
            "WHERE Name=\"_Total\""
        )
        return {
            "activity": _parse_int(self._wmi_val(row, "PercentDiskTime")),
            "temp": None, "read": None, "write": None,
        }

    def snapshot(self, gpu_index=None, skip_net=False) -> dict:
        return {
            "cpu": self._get_cpu(),
            "gpu": self._get_gpu(gpu_index),
            "mem": self._get_mem(),
            "disks": self._get_disk_partitions(),
            "disk_status": self._get_disk_status(),
            "net": self.get_network() if not skip_net else {"up": 0, "down": 0, "name": "N/A"},
        }

    def get_gpu_list(self):
        """返回可用 GPU 名称列表。"""
        adapters = self._query("SELECT Name FROM Win32_VideoController")
        if not adapters:
            return []
        names = []
        for a in adapters:
            n = self._wmi_val(a, "Name")
            if n:
                names.append(n)
        return names

    def get_hw_names(self):
        self._ensure_init()
        now = time.monotonic()
        if self._hw_names_cache is not None and now - self._hw_names_ts < _META_TTL:
            return self._hw_names_cache

        names = {"cpu": "CPU", "gpu": "GPU", "mem": "Memory", "disk": "Disk Status", "net": "Network"}
        proc = self._first("SELECT Name FROM Win32_Processor")
        cpu_name = self._wmi_val(proc, "Name")
        if cpu_name:
            names["cpu"] = cpu_name
        adapters = self._query("SELECT Name FROM Win32_VideoController")
        if adapters:
            name_l = [self._wmi_val(a, "Name", "").lower() for a in adapters]
            discrete = [i for i, n in enumerate(name_l) if not any(k in n for k in _IGPU_KEYWORDS)]
            idx = discrete[0] if discrete else 0
            gpu_name = self._wmi_val(adapters[idx], "Name")
            if gpu_name:
                names["gpu"] = gpu_name
        disk = self._first("SELECT Model FROM Win32_DiskDrive")
        disk_model = self._wmi_val(disk, "Model")
        if disk_model:
            names["disk"] = disk_model
        names["mem"] = self._get_mem_name()
        try:
            names["net"] = self._get_network_name()
        except Exception:
            pass
        self._hw_names_cache = names
        self._hw_names_ts = now
        return names

    def _get_mem_name(self):
        now = time.monotonic()
        if self._mem_name_cache is not None and now - self._mem_name_ts < _META_TTL:
            return self._mem_name_cache
        chip = self._first("SELECT PartNumber FROM Win32_PhysicalMemory")
        part = self._wmi_val(chip, "PartNumber")
        if part:
            self._mem_name_cache = part
            self._mem_name_ts = now
            return part
        return "Memory"

    def get_backend_info(self) -> dict:
        """后端名称 + 版本（关于页显示）。"""
        return {"name": "WMI", "version": None}

    def get_hw_detail(self, gpu_index=None) -> dict:
        return {
            "cpu": self._get_cpu_detail(),
            "gpu": self._get_gpu_detail(gpu_index),
            "mem": self._get_mem_detail(),
        }

    def _get_cpu_detail(self):
        now = time.monotonic()
        if self._cpu_detail_cache is not None and now - self._cpu_detail_ts < _META_TTL:
            return self._cpu_detail_cache

        info = {"name": "CPU", "cores": None, "threads": None, "socket": "",
                "arch": "", "cache_l1": "", "cache_l2": "", "cache_l3": "",
                "base_clock": "", "boost_clock": "", "sensors": {}}
        proc = self._first(
            "SELECT Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, "
            "SocketDesignation, L2CacheSize, L3CacheSize FROM Win32_Processor"
        )
        if proc:
            name = self._wmi_val(proc, "Name")
            if name:
                info["name"] = name
            info["cores"] = _parse_int(self._wmi_val(proc, "NumberOfCores"))
            info["threads"] = _parse_int(self._wmi_val(proc, "NumberOfLogicalProcessors"))
            info["socket"] = self._wmi_val(proc, "SocketDesignation", "")
            l2 = self._wmi_val(proc, "L2CacheSize")
            if l2:
                info["cache_l2"] = f"{l2} KB"
            l3 = self._wmi_val(proc, "L3CacheSize")
            if l3:
                info["cache_l3"] = f"{l3} KB"
            mhz = self._wmi_val(proc, "MaxClockSpeed")
            if mhz:
                info["base_clock"] = f"{mhz} MHz"
                info["boost_clock"] = f"{mhz} MHz"
        if info["threads"] is None:
            import os
            info["threads"] = os.cpu_count()
        self._cpu_detail_cache = info
        self._cpu_detail_ts = now
        return info

    def _get_gpu_detail(self, gpu_index=None):
        now = time.monotonic()
        cache_key = gpu_index if gpu_index is not None else -1
        cached = self._gpu_detail_cache.get(cache_key)
        if cached is not None and now - self._gpu_detail_ts < _META_TTL:
            return cached

        info = {"name": "GPU", "vram_type": "", "driver": "", "bios": "", "sensors": {}}
        adapters = self._query(
            "SELECT Name, DriverVersion FROM Win32_VideoController"
        )
        if not adapters:
            self._gpu_detail_cache = {cache_key: info}
            self._gpu_detail_ts = now
            return info
        if gpu_index is not None and 0 <= gpu_index < len(adapters):
            chosen = adapters[gpu_index]
        else:
            name_l = [self._wmi_val(a, "Name", "").lower() for a in adapters]
            discrete = [i for i, n in enumerate(name_l) if not any(k in n for k in _IGPU_KEYWORDS)]
            chosen = adapters[discrete[0]] if discrete else adapters[0]
        name = self._wmi_val(chosen, "Name")
        if name:
            info["name"] = name
        info["driver"] = self._wmi_val(chosen, "DriverVersion", "")
        self._gpu_detail_cache = {cache_key: info}
        self._gpu_detail_ts = now
        return info

    def _get_mem_detail(self):
        now = time.monotonic()
        if self._mem_detail_cache is not None and now - self._mem_detail_ts < _META_TTL:
            return self._mem_detail_cache

        info = {"name": "Memory", "type": "", "speed": "", "manufacturer": "",
                "part_number": "", "slot_count": 0, "form_factor": "",
                "total_gb": 0, "sensors": {}}
        vm = psutil.virtual_memory()
        info["total_gb"] = round(vm.total / 1073741824, 1)
        chips = self._query(
            "SELECT Speed, Manufacturer, PartNumber, Capacity, MemoryType, FormFactor, "
            "DeviceLocator FROM Win32_PhysicalMemory"
        )
        mem_types = {"20": "DDR", "21": "DDR2", "24": "DDR3", "26": "DDR4", "34": "DDR5"}
        form_factors = {"8": "DIMM", "12": "SODIMM"}
        if chips:
            info["name"] = "Memory"
            for c in chips:
                info["slot_count"] += 1
                if not info["speed"]:
                    spd = self._wmi_val(c, "Speed")
                    if spd:
                        info["speed"] = f"{spd} MHz"
                if not info["manufacturer"]:
                    mfr = self._wmi_val(c, "Manufacturer")
                    if mfr:
                        info["manufacturer"] = mfr
                if not info["part_number"]:
                    pn = self._wmi_val(c, "PartNumber")
                    if pn:
                        info["part_number"] = pn
                if not info["type"]:
                    mt = self._wmi_val(c, "MemoryType")
                    if mt:
                        info["type"] = mem_types.get(mt, f"Type {mt}")
                if not info["form_factor"]:
                    ff = self._wmi_val(c, "FormFactor")
                    if ff:
                        info["form_factor"] = form_factors.get(ff, "")
        self._mem_detail_cache = info
        self._mem_detail_ts = now
        return info
