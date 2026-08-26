"""基于 LibreHardwareMonitor 的硬件监视后端。"""

import os
import time
import psutil
from loguru import logger
from .base import BaseMonitor
from momoitor.config import LIB_DIR
from momoitor.services.catalog import lhm_sensor_kind

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
        rows = self._run_cim("Win32_PhysicalMemory", ["PartNumber"])
        parts = [str(r.get("PartNumber") or "").strip() for r in rows]
        parts = [p for p in parts if p]
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

    # ---- 原始传感器树（自选数据卡片）----
    #
    # ident 格式: "{hw_type}|{hw_name}|{sensor_type}|{sensor_name}"（均取 str()）。
    # 运行时按枚举顺序首匹配：同名硬件（如两块同型号硬盘）的传感器 ident 相同，
    # 目录构建时全局去重，仅保留首个条目，与运行时解析结果保持一致。

    def get_sensor_groups(self) -> list:
        self._ensure_init()
        groups = []
        index = {}   # 组名 -> 组 dict
        seen = set()
        for hw in self._computer.Hardware:
            self._collect_lhm_sensors(hw, str(hw.Name), groups, index, seen)
            for sub in hw.SubHardware:
                name = f"{str(hw.Name)} \u00b7 {str(sub.Name)}"
                self._collect_lhm_sensors(sub, name, groups, index, seen)
        return groups

    def _collect_lhm_sensors(self, hw, group_name, groups, index, seen):
        items = []
        for s in hw.Sensors:
            stype = str(s.SensorType)
            sname = str(s.Name)
            ident = f"{str(hw.HardwareType)}|{str(hw.Name)}|{stype}|{sname}"
            if ident in seen:
                continue
            seen.add(ident)
            items.append({
                "key": "raw:" + ident,
                "label": sname,
                "kind": lhm_sensor_kind(stype),
            })
        if not items:
            return
        group = index.get(group_name)
        if group is None:
            group = {"name": group_name, "items": []}
            index[group_name] = group
            groups.append(group)
        group["items"].extend(items)

    def get_sensor_value(self, ident: str):
        self._ensure_init()
        parts = str(ident or "").split("|")
        if len(parts) != 4:
            return None
        want_type, want_hw, want_stype, want_sname = (p.lower() for p in parts)
        # 快照轮询每秒都会 Update 全部硬件，此处直接读缓存值，不再重复 Update
        for hw in self._computer.Hardware:
            val = self._match_lhm_sensor(hw, want_type, want_hw, want_stype, want_sname)
            if val is not None:
                return val
            for sub in hw.SubHardware:
                val = self._match_lhm_sensor(sub, want_type, want_hw, want_stype, want_sname)
                if val is not None:
                    return val
        return None

    @staticmethod
    def _match_lhm_sensor(hw, want_type, want_hw, want_stype, want_sname):
        if str(hw.HardwareType).lower() != want_type or str(hw.Name).lower() != want_hw:
            return None
        for s in hw.Sensors:
            if str(s.SensorType).lower() == want_stype and str(s.Name).lower() == want_sname:
                v = s.Value
                try:
                    return float(v) if v is not None else None
                except (TypeError, ValueError):
                    return None
        return None


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
        rows = self._run_cim("Win32_Processor", [
            "NumberOfCores", "NumberOfLogicalProcessors", "Name",
            "MaxClockSpeed", "Architecture", "L2CacheSize", "L3CacheSize",
        ])
        if rows:
            row = rows[0]
            cores, threads = row.get("NumberOfCores"), row.get("NumberOfLogicalProcessors")
            info["cores"] = int(cores) if isinstance(cores, int) else None
            info["threads"] = int(threads) if isinstance(threads, int) else None
            arch = row.get("Architecture")
            info["arch"] = str(arch).strip() if arch is not None else ""
            l2, l3 = row.get("L2CacheSize"), row.get("L3CacheSize")
            info["cache_l2"] = f"{l2} KB" if l2 else ""
            info["cache_l3"] = f"{l3} KB" if l3 else ""
            mhz = row.get("MaxClockSpeed")
            mhz_s = f"{mhz} MHz" if mhz else ""
            info["base_clock"] = mhz_s
            info["boost_clock"] = mhz_s
        if info["threads"] is None:
            import os
            info["threads"] = os.cpu_count()
        for row in self._run_cim("Win32_Processor", ["SocketDesignation"]):
            socket = str(row.get("SocketDesignation") or "").strip()
            if socket:
                info["socket"] = socket
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
        target = info["name"].lower()
        rows = self._run_cim("Win32_VideoController", ["Name", "DriverVersion"])
        for row in rows:
            name = str(row.get("Name") or "")
            name_lower = name.lower()
            # Win32_VideoController 没有显存类型字段，vram_type 留空
            if target in name_lower or name_lower in target:
                info["driver"] = str(row.get("DriverVersion") or "").strip()
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
        rows = self._run_cim("Win32_PhysicalMemory", [
            "Speed", "Manufacturer", "PartNumber", "MemoryType", "FormFactor",
        ])
        mem_types = {20: "DDR", 21: "DDR2", 24: "DDR3", 26: "DDR4", 34: "DDR5"}
        form_factors = {8: "DIMM", 12: "SODIMM"}
        for row in rows:
            info["slot_count"] += 1
            speed = row.get("Speed")
            if not info["speed"] and speed:
                info["speed"] = f"{speed} MHz"
            manufacturer = str(row.get("Manufacturer") or "").strip()
            if not info["manufacturer"] and manufacturer:
                info["manufacturer"] = manufacturer
            part_number = str(row.get("PartNumber") or "").strip()
            if not info["part_number"] and part_number:
                info["part_number"] = part_number
            mtype = row.get("MemoryType")
            if not info["type"] and mtype is not None:
                if isinstance(mtype, int):
                    info["type"] = mem_types.get(mtype, f"Type {mtype}")
                else:
                    s = str(mtype).strip()
                    info["type"] = mem_types.get(int(s), f"Type {s}") if s.isdigit() else (s or "")
            ff = row.get("FormFactor")
            if not info["form_factor"] and ff is not None:
                if isinstance(ff, int):
                    info["form_factor"] = form_factors.get(ff, "")
                else:
                    s = str(ff).strip()
                    info["form_factor"] = form_factors.get(int(s), "") if s.isdigit() else ""
        self._mem_detail_cache = info
        self._mem_detail_ts = time.monotonic()
        return info
