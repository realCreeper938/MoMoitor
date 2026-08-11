"""基于 AIDA64 共享内存的硬件监视后端。

通过 ctypes 打开 AIDA64 的共享内存 `AIDA64_SensorValues`（需要在 AIDA64 的
"外部程序" 设置中勾选 "允许共享内存"，并建议将所有监控项全部勾选），读取以
NUL 结尾的 XML 格式传感器数据，解析各监控项。

共享内存内容形如：
    <temp><id>TCPUPKG</id><label>CPU Package</label><value>56.0</value></temp>
    <sys><id>SCPUCLK</id><label>CPU Clock</label><value>3940</value></sys>...

单位约定：温度 ℃、时钟 MHz、利用率 %、电压 V、功耗 W、内存/显存/磁盘空间 MB、
磁盘读写 MB/s。硬件名称（型号）不在共享内存中，从注册表读取并做 TTL 缓存。
"""

import ctypes
import re
import time
import winreg
from ctypes import wintypes

from .base import BaseMonitor

# 共享内存名称（官方文档：local/global 命名空间均可用，此处用默认名）。
_SHM_NAME = "AIDA64_SensorValues"
# 共享内存读取的分块大小；内容以 NUL 结尾，分块读取直到遇到结束符。
_SHM_READ_CHUNK = 4096

# 元数据（硬件名/列表）缓存时长。
_META_TTL = 300

# 常见核显关键字（用于挑选独显）。
_IGPU_KEYWORDS = ("microsoft", "basic", "uhd", "iris", "radeon graphics", "vega", "intel")

# 显示适配器注册表路径。
_DISPLAY_CLASS = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"

# AIDA64 传感器块：<类型><id>..</id><label>..</label><value>..</value></类型>
_SENSOR_RE = re.compile(
    r"<(\w+)><id>([^<]*)</id><label>([^<]*)</label><value>([^<]*)</value></\1>"
)


def _parse_float(raw, default=None):
    try:
        v = float(raw.strip())
        return v
    except (TypeError, ValueError):
        return default


def _parse_int(raw, default=None):
    v = _parse_float(raw)
    return int(v) if v is not None else default


def _read_registry_value(path, name):
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            value, _ = winreg.QueryValueEx(key, name)
            return str(value).strip()
    except OSError:
        return None


class AIDA64Monitor(BaseMonitor):
    """AIDA64 共享内存后端。"""

    def __init__(self):
        super().__init__()
        self._kernel32 = ctypes.windll.kernel32
        self._hw_names_cache = None
        self._hw_names_ts = 0
        self._gpu_list_cache = None
        self._gpu_list_ts = 0

    # ---- 共享内存读取 ----

    def _read_shared_memory(self):
        """读取 AIDA64 共享内存内容并返回原始字符串；失败抛 OSError。"""
        k32 = self._kernel32
        k32.OpenFileMappingW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
        k32.OpenFileMappingW.restype = wintypes.HANDLE
        k32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                      wintypes.DWORD, ctypes.c_size_t]
        k32.MapViewOfFile.restype = ctypes.c_void_p
        k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
        k32.UnmapViewOfFile.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.CloseHandle.restype = wintypes.BOOL

        handle = k32.OpenFileMappingW(0x4, False, _SHM_NAME)  # FILE_MAP_READ
        if not handle:
            raise OSError(f"AIDA64 shared memory '{_SHM_NAME}' not available")
        try:
            # 映射整个文件（size=0）。AIDA64 共享内存通常只有几 KB，映射一个
            # 固定的更大 size 会因超出实际大小而失败（ERROR_MAPPED_ALIGNMENT）。
            addr = k32.MapViewOfFile(handle, 0x4, 0, 0, 0)
            if not addr:
                raise OSError("failed to map AIDA64 shared memory")
            try:
                # 未知长度，分块读取直到遇到 NUL 结束符；共享内存内容即 C 字符串。
                data = b""
                offset = 0
                while True:
                    chunk = ctypes.string_at(addr + offset, _SHM_READ_CHUNK)
                    end = chunk.find(b"\x00")
                    if end != -1:
                        data += chunk[:end]
                        break
                    data += chunk
                    offset += _SHM_READ_CHUNK
                return data.decode("utf-8", errors="replace")
            finally:
                k32.UnmapViewOfFile(addr)
        finally:
            k32.CloseHandle(handle)

    def _read_sensors(self):
        """读取并解析全部传感器，返回 {id: (类型, label, value_str)}。"""
        content = self._read_shared_memory()
        result = {}
        for match in _SENSOR_RE.finditer(content):
            sensor_type, sid, label, value = match.groups()
            result[sid] = (sensor_type, label, value)
        return result

    def _sensor_float(self, sensors, sid):
        if sid not in sensors:
            return None
        return _parse_float(sensors[sid][2])

    def _sensor_int(self, sensors, sid):
        if sid not in sensors:
            return None
        return _parse_int(sensors[sid][2])

    # ---- 实时数据 ----

    def _get_cpu(self, sensors):
        cpu = {"clock": None, "temp": None, "power": None, "load": None, "voltage": None}
        cpu["clock"] = self._sensor_int(sensors, "SCPUCLK")
        cpu["load"] = self._sensor_int(sensors, "SCPUUTI")
        cpu["temp"] = self._sensor_float(sensors, "TCPUPKG")
        if cpu["temp"] is None:
            cpu["temp"] = self._sensor_float(sensors, "TCPU")
        cpu["power"] = self._sensor_float(sensors, "PCPUPKG")
        cpu["voltage"] = self._sensor_float(sensors, "VCPU")
        return cpu

    def _get_mem(self, sensors):
        mem = {"used_gb": 0, "total_gb": 0, "percent": 0, "temp": None, "volt": None, "clock": None}
        used_mb = self._sensor_float(sensors, "SUSEDMEM")
        free_mb = self._sensor_float(sensors, "SFREEMEM")
        if used_mb is None or free_mb is None:
            mem["percent"] = self._sensor_int(sensors, "SMEMUTI")
            mem["temp"] = self._sensor_float(sensors, "TDIMM")
            mem["volt"] = self._sensor_float(sensors, "VDIMM")
            mem["clock"] = self._sensor_int(sensors, "SMEMCLK")
            if mem["clock"] is None:
                mem["clock"] = self._sensor_int(sensors, "SMEMSPEED")
            return mem
        total_mb = used_mb + free_mb
        mem["used_gb"] = round(used_mb / 1024, 1)
        mem["total_gb"] = round(total_mb / 1024, 1)
        mem["percent"] = round(used_mb / total_mb * 100, 1) if total_mb > 0 else 0
        mem["temp"] = self._sensor_float(sensors, "TDIMM")
        mem["volt"] = self._sensor_float(sensors, "VDIMM")
        mem["clock"] = self._sensor_int(sensors, "SMEMCLK")
        if mem["clock"] is None:
            mem["clock"] = self._sensor_int(sensors, "SMEMSPEED")
        return mem

    def _get_gpu(self, sensors, gpu_index):
        gpu = {"temp": None, "power": None, "vram_used_gb": None, "vram_total_gb": None,
               "load": None, "vram_temp": None}
        # AIDA64 用 SGPU1..SGPU8 编号，gpu_index 从 0 开始。
        n = gpu_index + 1
        gpu["load"] = self._sensor_int(sensors, f"SGPU{n}UTI")
        gpu["temp"] = self._sensor_float(sensors, f"TGPU{n}")
        gpu["power"] = self._sensor_float(sensors, f"PGPU{n}")
        vram_used_mb = self._sensor_float(sensors, f"SGPU{n}USEDDEMEM")
        if vram_used_mb is not None:
            gpu["vram_used_gb"] = round(vram_used_mb / 1024, 1)
        # AIDA64 不提供显存总容量 ID，留空由前端显示 N/A。
        gpu["vram_temp"] = self._sensor_float(sensors, f"TGPU{n}MEM")
        return gpu

    def _get_disk_status(self, sensors):
        status = {"activity": None, "temp": None, "read": None, "write": None}
        status["activity"] = self._sensor_int(sensors, "SDSK1ACT")
        status["read"] = self._sensor_float(sensors, "SDSK1READSPD")
        status["write"] = self._sensor_float(sensors, "SDSK1WRITESPD")
        status["temp"] = self._sensor_float(sensors, "THDD1")
        return status

    def _get_battery(self, sensors):
        """电池：SBATTLVL（电量）、PBATTCHR（充电率 W）。"""
        percent = self._sensor_int(sensors, "SBATTLVL")
        rate_w = self._sensor_float(sensors, "PBATTCHR")
        # AIDA64 的充电率为 0 时表示未充电（无法区分交流供电与否）。
        return self._battery_from_signals(
            percent,
            rate_w is not None and rate_w > 0,
            None,
            rate_w,
        )

    def snapshot(self, gpu_index=None, skip_net=False) -> dict:
        sensors = self._read_sensors()
        if gpu_index is None:
            gpu_index = 0
        return {
            "cpu": self._get_cpu(sensors),
            "gpu": self._get_gpu(sensors, gpu_index),
            "mem": self._get_mem(sensors),
            "battery": self._get_battery(sensors),
            "disks": self._get_disk_partitions(),
            "disk_status": self._get_disk_status(sensors),
            "net": self.get_network() if not skip_net else {"up": 0, "down": 0, "name": "N/A"},
        }

    # ---- 硬件名称 / 列表（来自注册表）----

    def _gpu_adapters(self):
        """返回 [(subkey, DriverDesc), ...] 按注册表枚举顺序。"""
        adapters = []
        i = 0
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _DISPLAY_CLASS) as key:
                while True:
                    try:
                        sub = winreg.EnumKey(key, i)
                    except OSError:
                        break
                    desc = _read_registry_value(_DISPLAY_CLASS + "\\" + sub, "DriverDesc")
                    if desc:
                        adapters.append((sub, desc))
                    i += 1
        except OSError:
            return []
        return adapters

    def get_gpu_list(self):
        now = time.monotonic()
        if self._gpu_list_cache is not None and now - self._gpu_list_ts < _META_TTL:
            return self._gpu_list_cache
        self._gpu_list_cache = [desc for _, desc in self._gpu_adapters()]
        self._gpu_list_ts = now
        return self._gpu_list_cache

    def get_hw_names(self):
        now = time.monotonic()
        if self._hw_names_cache is not None and now - self._hw_names_ts < _META_TTL:
            return self._hw_names_cache

        names = {"cpu": "CPU", "gpu": "GPU", "mem": "Memory", "disk": "Disk Status", "net": "Network"}
        cpu = _read_registry_value(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
                                   "ProcessorNameString")
        if cpu:
            names["cpu"] = cpu
        adapters = self._gpu_adapters()
        if adapters:
            descs = [d.lower() for _, d in adapters]
            discrete = [i for i, d in enumerate(descs) if not any(k in d for k in _IGPU_KEYWORDS)]
            idx = discrete[0] if discrete else 0
            names["gpu"] = adapters[idx][1]
        names["mem"] = "Memory"
        try:
            names["net"] = self._get_network_name()
        except Exception:
            pass
        self._hw_names_cache = names
        self._hw_names_ts = now
        return names

    def get_backend_info(self) -> dict:
        return {"name": "AIDA64", "version": None}

    def get_hw_detail(self, gpu_index=None) -> dict:
        """从注册表拼出 cpu/gpu 规格；sensors 保留共享内存原始读数。"""
        try:
            sensors = self._read_sensors()
        except OSError:
            sensors = {}

        cpu_name = _read_registry_value(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
                                        "ProcessorNameString") or "CPU"
        cpu_detail = {"name": cpu_name, "cores": None, "threads": None, "socket": "",
                      "arch": "", "cache_l1": "", "cache_l2": "", "cache_l3": "",
                      "base_clock": "", "boost_clock": "", "sensors": {}}
        clk = self._sensor_int(sensors, "SCPUCLK")
        if clk:
            cpu_detail["base_clock"] = f"{clk} MHz"
            cpu_detail["boost_clock"] = f"{clk} MHz"
        for sid, label in (("TCPUPKG", "CPU Package"), ("SCPUUTI", "CPU Utilization"),
                           ("PCPUPKG", "CPU Package Power")):
            v = self._sensor_float(sensors, sid)
            if v is not None:
                cpu_detail["sensors"][label] = v

        adapters = self._gpu_adapters()
        if gpu_index is not None and 0 <= gpu_index < len(adapters):
            gpu_desc = adapters[gpu_index][1]
        elif adapters:
            descs = [d.lower() for _, d in adapters]
            discrete = [i for i, d in enumerate(descs) if not any(k in d for k in _IGPU_KEYWORDS)]
            gpu_desc = adapters[discrete[0]][1] if discrete else adapters[0][1]
        else:
            gpu_desc = "GPU"
        gpu_detail = {"name": gpu_desc, "vram_type": "", "driver": "", "bios": "",
                      "sensors": {}}
        n = (gpu_index or 0) + 1
        for sid, label in ((f"TGPU{n}", "GPU Temperature"), (f"SGPU{n}UTI", "GPU Utilization"),
                           (f"PGPU{n}", "GPU Power")):
            v = self._sensor_float(sensors, sid)
            if v is not None:
                gpu_detail["sensors"][label] = v

        mem_detail = {"name": "Memory", "type": "", "speed": "", "manufacturer": "",
                      "part_number": "", "slot_count": 0, "form_factor": "",
                      "total_gb": 0, "sensors": {}}
        used_mb = self._sensor_float(sensors, "SUSEDMEM")
        free_mb = self._sensor_float(sensors, "SFREEMEM")
        if used_mb is not None and free_mb is not None:
            mem_detail["total_gb"] = round((used_mb + free_mb) / 1024, 1)
        # SMEMCLK 是 MHz 数字；SMEMSPEED 可能是 "DDR5-5600" 之类的字符串，优先用数字。
        spd = self._sensor_int(sensors, "SMEMCLK") or self._sensor_int(sensors, "SMEMSPEED")
        if spd:
            mem_detail["speed"] = f"{spd} MHz"
        for sid, label in (("SMEMUTI", "Memory Utilization"), ("TDIMM", "DIMM Temperature"),
                           ("VDIMM", "DIMM Voltage")):
            v = self._sensor_float(sensors, sid)
            if v is not None:
                mem_detail["sensors"][label] = v

        return {"cpu": cpu_detail, "gpu": gpu_detail, "mem": mem_detail}

    def close(self):
        pass
