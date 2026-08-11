"""基于 LibreHardwareMonitor 的硬件监视后端。"""

import os
import time
import psutil
from loguru import logger
from .base import BaseMonitor
from momoitor.config import LIB_DIR

DLL_PATH = os.path.join(LIB_DIR, "LibreHardwareMonitorLib.dll")

# 静态硬件元数据（名称、WMIC 派生的规格）很少变化。
_META_TTL = 300


class LHMMonitor(BaseMonitor):
    def __init__(self):
        super().__init__()
        # 延迟初始化：clr.AddReference + Computer.Open 会加载 .NET 运行时并枚举
        # 硬件，耗时可达数百毫秒。窗口应先弹出，硬件初始化推迟到首次真正读取数据。
        self._computer = None
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
        """首次访问时初始化 LHM（加载程序集 + 打开硬件）。线程安全。"""
        if self._initialized:
            return
        import threading
        with threading.Lock():
            if self._initialized:
                return
            import clr
            clr.AddReference(DLL_PATH)
            from LibreHardwareMonitor.Hardware import Computer
            computer = Computer()
            computer.IsCpuEnabled = True
            computer.IsGpuEnabled = True
            computer.IsMemoryEnabled = True
            computer.IsStorageEnabled = True
            computer.IsBatteryEnabled = True
            # 网络吞吐来自 BaseMonitor 中的 psutil。
            computer.IsNetworkEnabled = False
            computer.Open()
            self._computer = computer
            self._initialized = True
            logger.info("LHM backend initialized")

    def close(self):
        if self._computer is not None:
            self._computer.Close()
            logger.info("LHM backend closed")

    def get_backend_info(self) -> dict:
        """LibreHardwareMonitorLib.dll 程序集版本。"""
        try:
            import clr
            asm = clr.System.Reflection.Assembly.LoadFrom(DLL_PATH)
            version = str(asm.GetName().Version)
        except Exception:
            version = None
        return {"name": "LibreHardwareMonitor", "version": version}

    def _read_sensors(self, hw):
        sensors = []
        for s in hw.Sensors:
            name = str(s.Name)
            sensors.append({"name": name, "name_lower": name.lower(), "type": str(s.SensorType), "value": s.Value})
        for sub in hw.SubHardware:
            sub.Update()
            for s in sub.Sensors:
                name = str(s.Name)
                sensors.append({"name": name, "name_lower": name.lower(), "type": str(s.SensorType), "value": s.Value})
        return sensors

    def _find(self, sensors, stype, keywords):
        keywords = tuple(k.lower() for k in keywords)
        for s in sensors:
            if s["type"] == stype:
                if all(k in s["name_lower"] for k in keywords):
                    return s["value"]
        return None

    def _agg(self, sensors, stype, keywords):
        keywords = tuple(k.lower() for k in keywords)
        vals = [float(s["value"]) for s in sensors
                if s["type"] == stype
                and all(k in s["name_lower"] for k in keywords)
                and s["value"] is not None]
        return max(vals) if vals else None

    _DISCRETE_KEYWORDS = {"rx ", "r9 ", "r7 ", "r5 ", "geforce", "rtx", "gtx", "quadro", "radeon pro"}
    _IGPU_KEYWORDS = {"vega", "graphics", "uhd", "iris"}

    def _gpu_priority(self, hw):
        ht = str(hw.HardwareType).lower()
        name = str(hw.Name).lower()
        if "nvidia" in ht:
            return 0
        if "intel" in ht:
            return 2
        if "amd" in ht:
            if any(k in name for k in self._IGPU_KEYWORDS):
                return 2
            if any(k in name for k in self._DISCRETE_KEYWORDS):
                return 0
            return 1
        return 1

    def snapshot(self, gpu_index=None, skip_net=False) -> dict:
        self._ensure_init()
        cpu_data = {"clock": None, "temp": None, "power": None, "load": None, "voltage": None}
        gpu_data = {"temp": None, "power": None, "vram_used_gb": None, "vram_total_gb": None, "load": None, "vram_temp": None}
        mem_temp = None
        mem_clock = None
        mem_volt = None
        disk_status = {"activity": None, "temp": None, "read": None, "write": None}
        battery_data = self._battery_from_signals(None, None, None, None)
        gpu_candidates = []

        for hw in self._computer.Hardware:
            hw.Update()
            ht = str(hw.HardwareType)
            sensors = self._read_sensors(hw)

            if ht.startswith("Cpu"):
                cpu_data["temp"] = self._find(sensors, "Temperature", ["package"])
                if cpu_data["temp"] is None:
                    cpu_data["temp"] = self._agg(sensors, "Temperature", ["core"])
                cpu_data["clock"] = self._find(sensors, "Clock", ["package"])
                if cpu_data["clock"] is None:
                    cpu_data["clock"] = self._agg(sensors, "Clock", ["core"])
                cpu_data["power"] = self._find(sensors, "Power", ["package"])
                cpu_data["load"] = self._find(sensors, "Load", ["total"])
                cpu_data["voltage"] = self._find(sensors, "Voltage", ["package"]) or self._find(sensors, "Voltage", ["core"])

            elif "Gpu" in ht:
                gpu_candidates.append((hw, sensors))

            elif ht == "Memory":
                name = str(hw.Name)
                if name not in ("Total Memory", "Virtual Memory"):
                    t = self._find(sensors, "Temperature", [])
                    if t is not None:
                        mem_temp = float(t)
                    c = self._find(sensors, "Clock", ["memory"]) or self._find(sensors, "Clock", [])
                    if c is not None:
                        mem_clock = float(c)
                    v = self._find(sensors, "Voltage", ["vdd"]) or self._find(sensors, "Voltage", ["dram"]) or self._find(sensors, "Voltage", [])
                    if v is not None:
                        mem_volt = float(v)

            elif ht == "Storage":
                if disk_status["temp"] is None:
                    t = self._find(sensors, "Temperature", [])
                    if t is not None:
                        disk_status["temp"] = float(t)
                a = self._find(sensors, "Load", ["activity"])
                if a is not None and disk_status["activity"] is None:
                    disk_status["activity"] = float(a)
                r = self._find(sensors, "Throughput", ["read"])
                if r is not None:
                    disk_status["read"] = float(r)
                w = self._find(sensors, "Throughput", ["write"])
                if w is not None:
                    disk_status["write"] = float(w)

            elif "attery" in ht:
                battery_percent = self._find(sensors, "Level", ["charge"])
                rate = self._find(sensors, "Power", ["charge"])
                if rate is None:
                    rate = self._find(sensors, "Power", ["discharge"])
                if rate is not None:
                    rate = float(rate)
                # LHM 的 Charge/Discharge Rate：放电为负值，充电为正值。
                battery_data = self._battery_from_signals(
                    round(battery_percent) if battery_percent is not None else None,
                    rate is not None and rate > 0,
                    None,
                    rate,
                )

        # GPU
        if gpu_candidates:
            if gpu_index is not None and 0 <= gpu_index < len(gpu_candidates):
                hw, sensors = gpu_candidates[gpu_index]
            else:
                hw, sensors = min(gpu_candidates, key=lambda x: self._gpu_priority(x[0]))
            gpu_data["temp"] = self._find(sensors, "Temperature", ["gpu core"]) or self._find(sensors, "Temperature", ["gpu"])
            gpu_data["power"] = self._find(sensors, "Power", ["gpu"])
            gpu_data["load"] = self._find(sensors, "Load", ["gpu core"]) or self._find(sensors, "Load", ["gpu"])
            vt = self._find(sensors, "SmallData", ["dedicated", "total"]) or self._find(sensors, "SmallData", ["memory total"])
            vu = self._find(sensors, "SmallData", ["dedicated", "used"]) or self._find(sensors, "SmallData", ["memory used"])
            gpu_data["vram_total_gb"] = round(vt / 1024, 1) if vt else None
            gpu_data["vram_used_gb"] = round(vu / 1024, 1) if vu else None
            gpu_data["vram_temp"] = self._find(sensors, "Temperature", ["memory"]) or self._find(sensors, "Temperature", ["vram"])

        # 内存
        vm = psutil.virtual_memory()
        mem = {
            "used_gb": round(vm.used / 1073741824, 1),
            "total_gb": round(vm.total / 1073741824, 1),
            "percent": vm.percent,
            "temp": mem_temp,
            "volt": None,
            "clock": mem_clock,
        }
        if mem_volt is not None:
            mem["volt"] = mem_volt

        return {
            "cpu": cpu_data,
            "gpu": gpu_data,
            "mem": mem,
            "battery": battery_data,
            "disks": self._get_disk_partitions(),
            "disk_status": disk_status,
            "net": self.get_network() if not skip_net else {"up": 0, "down": 0, "name": "N/A"},
        }

    # 独立 getter：单传感器查询，为兼容旧 API 保留（snapshot 已是单遍采集）
    def get_gpu_list(self):
        """返回可用 GPU 名称列表。"""
        self._ensure_init()
        gpus = []
        for hw in self._computer.Hardware:
            if "Gpu" in str(hw.HardwareType):
                gpus.append(str(hw.Name))
        return gpus

    def get_hw_names(self):
        self._ensure_init()
        now = time.monotonic()
        if self._hw_names_cache is not None and now - self._hw_names_ts < _META_TTL:
            return self._hw_names_cache

        names = {"cpu": "CPU", "gpu": "GPU", "mem": "Memory", "disk": "Disk Status", "net": "Network"}
        for hw in self._computer.Hardware:
            ht = str(hw.HardwareType)
            if ht.startswith("Cpu"):
                names["cpu"] = str(hw.Name)
            elif "Gpu" in ht:
                if self._gpu_priority(hw) == 0 or "gpu" not in names or names["gpu"] == "GPU":
                    names["gpu"] = str(hw.Name)
            elif ht == "Storage":
                if names["disk"] == "Disk Status":
                    names["disk"] = str(hw.Name)
        names["mem"] = self._get_mem_name()
        try:
            names["net"] = self._get_network_name()
        except Exception:
            pass
        self._hw_names_cache = names
        self._hw_names_ts = now
        logger.debug("HW names: cpu={}, gpu={}, mem={}, disk={}, net={}", names["cpu"], names["gpu"], names["mem"], names["disk"], names["net"])
        return names

    def _get_mem_name(self):
        now = time.monotonic()
        if self._mem_name_cache is not None and now - self._mem_name_ts < _META_TTL:
            return self._mem_name_cache
        out = self._run_wmic(["memorychip", "get", "partnumber"])
        parts = [l.strip() for l in out.splitlines()[1:] if l.strip()]
        if parts:
            self._mem_name_cache = parts[0]
            self._mem_name_ts = now
            return parts[0]
        return "Memory"

    def get_hw_detail(self, gpu_index=None) -> dict:
        return {
            "cpu": self._get_cpu_detail(),
            "gpu": self._get_gpu_detail(gpu_index),
            "mem": self._get_mem_detail(),
        }

    def _get_cpu_detail(self):
        self._ensure_init()
        now = time.monotonic()
        if self._cpu_detail_cache is not None and now - self._cpu_detail_ts < _META_TTL:
            return self._cpu_detail_cache

        info = {"name": "CPU", "cores": None, "threads": None, "socket": "",
                "arch": "", "cache_l1": "", "cache_l2": "", "cache_l3": "",
                "base_clock": "", "boost_clock": "", "sensors": {}}
        for hw in self._computer.Hardware:
            if str(hw.HardwareType).startswith("Cpu"):
                info["name"] = str(hw.Name)
                hw.Update()
                sensors = self._read_sensors(hw)
                for s in sensors:
                    key = f"{s['type']}_{s['name_lower']}"
                    if s["value"] is not None:
                        info["sensors"][key] = round(float(s["value"]), 2)
                break
        out = self._run_wmic([
            "cpu", "get",
            "NumberOfCores,NumberOfLogicalProcessors,"
            "Name,MaxClockSpeed,Architecture,L2CacheSize,L3CacheSize",
            "/format:csv"
        ])
        lines = [l.strip() for l in out.splitlines() if l.strip() and l.strip() != "Node"]
        if len(lines) > 1:
            parts = lines[1].split(",")
            if len(parts) >= 8:
                # CSV 布局（/format:csv 会在前面加上 Node）：
                # [0]=Node [1]=NumberOfCores [2]=NumberOfLogicalProcessors
                # [3]=Name [4]=MaxClockSpeed [5]=Architecture
                # [6]=L2CacheSize [7]=L3CacheSize
                info["cores"] = int(parts[1]) if parts[1].isdigit() else None
                info["threads"] = int(parts[2]) if parts[2].isdigit() else None
                info["arch"] = parts[5] if parts[5] else ""
                info["cache_l2"] = f"{parts[6]} KB" if parts[6] else ""
                info["cache_l3"] = f"{parts[7]} KB" if parts[7] else ""
                info["base_clock"] = f"{parts[4]} MHz" if parts[4] else ""
                info["boost_clock"] = f"{parts[4]} MHz" if parts[4] else ""
        if info["threads"] is None:
            import os
            info["threads"] = os.cpu_count()
        out = self._run_wmic(["cpu", "get", "SocketDesignation", "/format:list"])
        for line in out.splitlines():
            if line.startswith("SocketDesignation="):
                info["socket"] = line.split("=", 1)[1].strip()
                break
        self._cpu_detail_cache = info
        self._cpu_detail_ts = time.monotonic()
        return info

    def _get_gpu_detail(self, gpu_index=None):
        self._ensure_init()
        now = time.monotonic()
        cache_key = gpu_index if gpu_index is not None else -1
        cached = self._gpu_detail_cache.get(cache_key)
        if cached is not None and now - self._gpu_detail_ts < _META_TTL:
            return cached

        info = {"name": "GPU", "vram_type": "", "driver": "", "bios": "",
                "sensors": {}}
        gpu_hw = []
        for hw in self._computer.Hardware:
            if "Gpu" in str(hw.HardwareType):
                gpu_hw.append(hw)
        if not gpu_hw:
            return info
        if gpu_index is not None and 0 <= gpu_index < len(gpu_hw):
            chosen = gpu_hw[gpu_index]
        else:
            chosen = min(gpu_hw, key=self._gpu_priority)
        info["name"] = str(chosen.Name)
        chosen.Update()
        sensors = self._read_sensors(chosen)
        for s in sensors:
            key = f"{s['type']}_{s['name_lower']}"
            if s["value"] is not None:
                info["sensors"][key] = round(float(s["value"]), 2)
        out = self._run_wmic([
            "path", "win32_videocontroller", "get",
            "Name,DriverVersion,AdapterRAM,VideoProcessor", "/format:csv"
        ])
        lines = [l.strip() for l in out.splitlines() if l.strip() and l.strip() != "Node"]
        for line in lines:
            parts = line.split(",")
            if len(parts) >= 4:
                if info["name"].lower() in parts[1].lower() or parts[1].lower() in info["name"].lower():
                    info["driver"] = parts[2] if parts[2] else ""
                    # parts[3]=AdapterRAM 是 uint32 字节数（并非显存类型）；
                    # Win32_VideoController 没有显存类型字段，因此 vram_type 留空
                    break
        self._gpu_detail_cache = {cache_key: info}
        self._gpu_detail_ts = time.monotonic()
        return info

    def _get_mem_detail(self):
        self._ensure_init()
        now = time.monotonic()
        if self._mem_detail_cache is not None and now - self._mem_detail_ts < _META_TTL:
            return self._mem_detail_cache

        info = {"name": "Memory", "type": "", "speed": "", "manufacturer": "",
                "part_number": "", "slot_count": 0, "form_factor": "",
                "total_gb": 0, "sensors": {}}
        vm = psutil.virtual_memory()
        info["total_gb"] = round(vm.total / 1073741824, 1)
        for hw in self._computer.Hardware:
            ht = str(hw.HardwareType)
            name = str(hw.Name)
            if ht == "Memory" and name not in ("Total Memory", "Virtual Memory"):
                info["name"] = name
                hw.Update()
                sensors = self._read_sensors(hw)
                for s in sensors:
                    key = f"{s['type']}_{s['name_lower']}"
                    if s["value"] is not None:
                        info["sensors"][key] = round(float(s["value"]), 2)
                break
        out = self._run_wmic([
            "memorychip", "get",
            "Speed,Manufacturer,PartNumber,MemoryType,FormFactor,DeviceLocator",
            "/format:csv"
        ])
        lines = [l.strip() for l in out.splitlines() if l.strip() and l.strip() != "Node"]
        if lines and lines[0].lower().startswith("node,"):
            lines = lines[1:]
        mem_types = {"20": "DDR", "21": "DDR2", "24": "DDR3", "26": "DDR4", "34": "DDR5"}
        form_factors = {"8": "DIMM", "12": "SODIMM"}
        for line in lines:
            parts = line.split(",")
            if len(parts) >= 7:
                info["slot_count"] += 1
                if not info["speed"] and parts[1]:
                    info["speed"] = f"{parts[1]} MHz"
                if not info["manufacturer"] and parts[2]:
                    info["manufacturer"] = parts[2].strip()
                if not info["part_number"] and parts[3]:
                    info["part_number"] = parts[3].strip()
                if not info["type"] and parts[4]:
                    info["type"] = mem_types.get(parts[4].strip(), f"Type {parts[4]}")
                if not info["form_factor"] and parts[5]:
                    info["form_factor"] = form_factors.get(parts[5].strip(), "")
        self._mem_detail_cache = info
        self._mem_detail_ts = time.monotonic()
        return info
