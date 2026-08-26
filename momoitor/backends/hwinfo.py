"""基于 HWiNFO 共享内存的硬件监视后端。"""

import ctypes
import ctypes.wintypes
import struct
import psutil
from loguru import logger
from . import _shm
from .base import BaseMonitor
from momoitor.services.catalog import hwinfo_sensor_kind

# HWiNFO 共享内存常量
HWINFO_SM2_NAME = "Global\\HWiNFO_SENS_SM2"
SENSOR_STR_LEN = 128
UNIT_STR_LEN = 16

# 读数类型（来自 HWiNFO SDK）
SENSOR_TYPE_NONE = 0
SENSOR_TYPE_TEMP = 1
SENSOR_TYPE_VOLT = 2
SENSOR_TYPE_FAN = 3
SENSOR_TYPE_CURRENT = 4
SENSOR_TYPE_POWER = 5
SENSOR_TYPE_CLOCK = 6
SENSOR_TYPE_USAGE = 7
SENSOR_TYPE_OTHER = 8

FILE_MAP_READ = 0x0004
MAX_SM_BYTES = 20_000_000


def _null_terminated(raw: bytes) -> str:
    idx = raw.find(b'\x00')
    if idx >= 0:
        raw = raw[:idx]
    try:
        return raw.decode('utf-8', errors='replace')
    except Exception:
        return raw.decode('ascii', errors='replace')


def _read_float64(data: bytes, offset: int) -> float:
    return struct.unpack_from('<d', data, offset)[0]


def _read_uint32(data: bytes, offset: int) -> int:
    return struct.unpack_from('<I', data, offset)[0]


class HWiNFOMonitor(BaseMonitor):
    def __init__(self):
        super().__init__()
        self._hw_names = None
        logger.info("HWiNFO backend initialized")

    def close(self):
        pass

    def get_backend_info(self) -> dict:
        """不显示 HWiNFO 程序版本（共享内存仅含协议版本，无可靠途径）。"""
        return {"name": "HWiNFO", "version": None}

    def _read_shared_memory(self):
        """从 HWiNFO 共享内存读取全部读数。"""
        h_mapping = _shm.open_mapping(HWINFO_SM2_NAME)
        if not h_mapping:
            raise OSError("Cannot open HWiNFO shared memory. Is HWiNFO running with shared memory enabled?")

        try:
            ptr = _shm.map_view(h_mapping)
            if not ptr:
                raise OSError("Cannot map HWiNFO shared memory view")

            try:
                # 一次性复制全部数据，保证快照一致
                header_bytes = ctypes.string_at(ptr, 48)

                # 解析头部（48 字节）
                header_fmt = '<4sII8sIIIIIII'
                (status, version, revision, last_update,
                 sensor_offset, sensor_size, sensor_count,
                 reading_offset, reading_size, reading_count,
                 polling_ms) = struct.unpack_from(header_fmt, header_bytes, 0)

                if status != b'HWiS':
                    raise OSError("HWiNFO shared memory is not active")

                # 复制整个数据区
                total = reading_offset + reading_count * reading_size
                if total > MAX_SM_BYTES:
                    raise OSError(f"HWiNFO shared memory too large: {total} bytes")
                data = ctypes.string_at(ptr, total)

                # 解析传感器
                sensors = []
                for i in range(sensor_count):
                    base = sensor_offset + i * sensor_size
                    sid = _read_uint32(data, base)
                    sinst = _read_uint32(data, base + 4)
                    name_raw = bytes(data[base + 8: base + 8 + SENSOR_STR_LEN])
                    name = _null_terminated(name_raw)
                    sensors.append({'id': sid, 'instance': sinst, 'name': name})

                # 解析读数结构：
                #  0: Type (uint32)
                #  4: SensorIndex (uint32)
                #  8: Id (uint32)
                # 12: OriginalLabelAscii (128 bytes)
                # 140: UserLabelAscii (128 bytes)
                # 268: UnitAscii (16 bytes)
                # 284: Value (float64, 8 bytes)
                # 292: ValueMin (float64)
                # 300: ValueMax (float64)
                # 308: ValueAvg (float64)
                # 316: UserLabel (128 bytes, UTF-8)
                # 444: Unit (16 bytes, UTF-8)
                results = []
                for i in range(reading_count):
                    base = reading_offset + i * reading_size
                    rtype = _read_uint32(data, base)
                    sensor_idx = _read_uint32(data, base + 4)
                    rid = _read_uint32(data, base + 8)
                    label_raw = bytes(data[base + 12: base + 12 + SENSOR_STR_LEN])
                    label = _null_terminated(label_raw)
                    value = _read_float64(data, base + 284)
                    unit_raw = bytes(data[base + 444: base + 444 + UNIT_STR_LEN])
                    unit = _null_terminated(unit_raw)

                    sensor_name = sensors[sensor_idx]['name'] if sensor_idx < sensor_count else ''
                    results.append({
                        'type': rtype,
                        'sensor_idx': sensor_idx,
                        'id': rid,
                        'label': label,
                        'value': value,
                        'unit': unit,
                        'sensor_name': sensor_name,
                    })

                return results
            finally:
                _shm.unmap_view(ptr)
        finally:
            _shm.close_handle(h_mapping)

    def _find_readings(self, readings, rtype, label_keywords, sensor_keywords=None):
        """查找匹配指定类型 + 任意标签关键字（+ 可选的传感器名关键字）的读数。"""
        label_keywords = tuple(k.lower() for k in label_keywords)
        if sensor_keywords:
            sensor_keywords = tuple(k.lower() for k in sensor_keywords)
        results = []
        for r in readings:
            if r['type'] != rtype:
                continue
            label_lower = r['label'].lower()
            if not any(k in label_lower for k in label_keywords):
                continue
            if sensor_keywords:
                sname_lower = r['sensor_name'].lower().replace('.', '')
                if not any(k in sname_lower for k in sensor_keywords):
                    continue
            results.append(r)
        return results

    def snapshot(self, gpu_index=None, skip_net=False) -> dict:
        readings = self._read_shared_memory()

        # 缓存硬件名称
        if self._hw_names is None:
            self._hw_names = self._extract_hw_names(readings)

        cpu = self._extract_cpu(readings)
        gpu = self._extract_gpu(readings)
        mem = self._extract_memory(readings)
        disk_status = self._extract_disk_status(readings)

        return {
            "cpu": cpu,
            "gpu": gpu,
            "mem": mem,
            "disks": self._get_disk_partitions(),
            "disk_status": disk_status,
            "net": self.get_network() if not skip_net else {"up": 0, "down": 0, "name": "N/A"},
        }

    def _extract_cpu(self, readings):
        data = {"clock": None, "temp": None, "power": None, "load": None, "voltage": None}

        # 温度："CPU Package"、"CPU (Tctl/Tdie)" 或 "CPU Die (average)"
        for keywords in [["cpu", "package"], ["tctl/tdie"], ["cpu", "die", "average"], ["cpu", "ccd"]]:
            found = self._find_readings(readings, SENSOR_TYPE_TEMP, keywords)
            if found:
                data["temp"] = found[0]['value']
                break

        # 频率："CPU Package" 或 "Core" 频率
        found = self._find_readings(readings, SENSOR_TYPE_CLOCK, ["cpu", "package"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_CLOCK, ["core"])
        if found:
            data["clock"] = max(r['value'] for r in found)

        # 功耗："CPU Package"
        found = self._find_readings(readings, SENSOR_TYPE_POWER, ["cpu", "package"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_POWER, ["cpu"])
        if found:
            data["power"] = found[0]['value']

        # 使用率："CPU Total" 或 "Total"
        found = self._find_readings(readings, SENSOR_TYPE_USAGE, ["cpu", "total"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_USAGE, ["total"])
        if found:
            data["load"] = found[0]['value']

        # 电压："CPU VDD" 或 "VID"
        found = self._find_readings(readings, SENSOR_TYPE_VOLT, ["cpu", "vdd"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_VOLT, ["vid"])
        if found:
            data["voltage"] = found[0]['value']

        return data

    def _extract_gpu(self, readings):
        data = {"temp": None, "power": None, "vram_used_gb": None, "vram_total_gb": None, "load": None, "vram_temp": None}

        # 找出所有 GPU 传感器索引，挑选最佳的一个（独显 > 核显）
        gpu_sensors = {}  # sensor_idx -> 传感器名
        for r in readings:
            if r['type'] in (SENSOR_TYPE_TEMP, SENSOR_TYPE_USAGE, SENSOR_TYPE_POWER):
                sl = r['sensor_name'].lower()
                if 'gpu' in sl or 'geforce' in sl or 'radeon' in sl:
                    idx = r['sensor_idx']
                    if idx not in gpu_sensors:
                        gpu_sensors[idx] = r['sensor_name']

        best_idx = self._pick_gpu_sensor(gpu_sensors)

        def find_gpu(rtype, keywords):
            """从选定的 GPU 传感器中查找读数。"""
            for r in readings:
                if r['type'] != rtype:
                    continue
                if best_idx is not None and r['sensor_idx'] != best_idx:
                    continue
                label_lower = r['label'].lower()
                if any(k.lower() in label_lower for k in keywords):
                    return r
            return None

        # 温度
        found = find_gpu(SENSOR_TYPE_TEMP, ["gpu", "temperature"])
        if not found:
            found = find_gpu(SENSOR_TYPE_TEMP, ["gpu"])
        if found:
            data["temp"] = found['value']

        # 功耗
        found = find_gpu(SENSOR_TYPE_POWER, ["gpu"])
        if found:
            data["power"] = found['value']

        # 使用率
        found = find_gpu(SENSOR_TYPE_USAGE, ["gpu", "core"])
        if not found:
            found = find_gpu(SENSOR_TYPE_USAGE, ["gpu", "utilization"])
        if not found:
            found = find_gpu(SENSOR_TYPE_USAGE, ["gpu", "d3d"])
        if found:
            data["load"] = found['value']

        # 显存占用："GPU Memory Allocated"（OTHER，单位 MB）—— 标签唯一，无需传感器过滤
        found = self._find_readings(readings, SENSOR_TYPE_OTHER, ["gpu", "memory", "allocated"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_OTHER, ["gpu", "memory", "used"])
        if found:
            data["vram_used_gb"] = round(found[0]['value'] / 1024, 1)

        # 显存总量：Available + Allocated
        found_avail = self._find_readings(readings, SENSOR_TYPE_OTHER, ["gpu", "memory", "available"])
        found_alloc = self._find_readings(readings, SENSOR_TYPE_OTHER, ["gpu", "memory", "allocated"])
        if found_avail and found_alloc:
            data["vram_total_gb"] = round((found_avail[0]['value'] + found_alloc[0]['value']) / 1024, 1)

        # 显存温度："GPU Memory Junction Temperature" —— 仅来自独显传感器
        found = find_gpu(SENSOR_TYPE_TEMP, ["memory junction"])
        if not found:
            found = find_gpu(SENSOR_TYPE_TEMP, ["memory temperature"])
        if found:
            data["vram_temp"] = found['value']

        return data

    def _pick_gpu_sensor(self, gpu_sensors):
        """挑选最佳 GPU 传感器索引：独显 > 独显 AMD > 核显。"""
        if not gpu_sensors:
            return None
        if len(gpu_sensors) == 1:
            return list(gpu_sensors.keys())[0]

        _IGPU_KW = {"igpu", "vega", "graphics", "uhd", "iris", "radeon 780m", "radeon 680m"}
        _DGPU_KW = {"dgpu", "geforce", "rtx", "gtx", "quadro", "radeon pro", "rx "}

        best_idx = None
        best_score = -1
        for idx, name in gpu_sensors.items():
            nl = name.lower()
            if any(k in nl for k in _DGPU_KW):
                score = 2
            elif any(k in nl for k in _IGPU_KW):
                score = 0
            else:
                score = 1
            if score > best_score:
                best_score = score
                best_idx = idx
        return best_idx

    def _extract_memory(self, readings):
        vm = psutil.virtual_memory()
        data = {
            "used_gb": round(vm.used / 1073741824, 1),
            "total_gb": round(vm.total / 1073741824, 1),
            "percent": vm.percent,
            "temp": None,
            "volt": None,
            "clock": None,
        }

        # 内存温度来自 DIMM 传感器
        found = self._find_readings(readings, SENSOR_TYPE_TEMP, ["dimm", "temp"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_TEMP, ["memory", "temp"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_TEMP, ["dimm"])
        if found:
            data["temp"] = max(r['value'] for r in found)

        # 内存电压来自 DIMM 传感器 —— 标签为 "VDD (SWA) Voltage"，传感器名含 "DIMM"
        found = self._find_readings(readings, SENSOR_TYPE_VOLT, ["vdd"], ["dimm"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_VOLT, ["vddq"], ["dimm"])
        if found:
            data["volt"] = found[0]['value']

        # 内存频率。HWiNFO 标签随主板而异，先尝试特定名称，
        # 再回退到与 DIMM 相关的频率读数。
        found = self._find_readings(readings, SENSOR_TYPE_CLOCK, ["memory", "clock"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_CLOCK, ["dram"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_CLOCK, ["clock"], ["dimm"])
        if found:
            data["clock"] = max(r['value'] for r in found)

        return data

    def _extract_disk_status(self, readings):
        data = {"activity": None, "temp": None, "read": None, "write": None}

        # 活动度："Total Activity"（USAGE 类型，来自 Drive 传感器）
        found = self._find_readings(readings, SENSOR_TYPE_USAGE, ["total", "activity"], ["drive"])
        if not found:
            found = self._find_readings(readings, SENSOR_TYPE_USAGE, ["activity"], ["drive"])
        if found:
            data["activity"] = found[0]['value']

        # 温度："Drive Temperature"（TEMP 类型，来自 Drive 或 SMART 传感器）
        found = self._find_readings(readings, SENSOR_TYPE_TEMP, ["drive temperature"], ["drive", "smart"])
        if found:
            data["temp"] = found[0]['value']

        # 读取速率："Read Rate"（OTHER 类型，来自 Drive 传感器，MB/s → 字节/s）
        found = self._find_readings(readings, SENSOR_TYPE_OTHER, ["read rate"], ["drive"])
        if found:
            data["read"] = found[0]['value'] * 1048576

        # 写入速率："Write Rate"（OTHER 类型，来自 Drive 传感器，MB/s → 字节/s）
        found = self._find_readings(readings, SENSOR_TYPE_OTHER, ["write rate"], ["drive"])
        if found:
            data["write"] = found[0]['value'] * 1048576

        return data

    def _extract_hw_names(self, readings):
        names = {"cpu": "CPU", "gpu": "GPU", "mem": "Memory", "disk": "Disk Status"}
        gpu_candidates = {}
        for r in readings:
            sname = r['sensor_name']
            sl = sname.lower()
            if 'cpu' in sl and names["cpu"] == "CPU":
                names["cpu"] = sname.split(':')[-1].strip() if ':' in sname else sname
            if ('gpu' in sl or 'geforce' in sl or 'radeon' in sl) and r['sensor_idx'] not in gpu_candidates:
                gpu_candidates[r['sensor_idx']] = sname
            if 'drive' in sl and names["disk"] == "Disk Status":
                names["disk"] = sname.split(':')[-1].strip() if ':' in sname else sname
        best_idx = self._pick_gpu_sensor(gpu_candidates)
        if best_idx is not None:
            sname = gpu_candidates[best_idx]
            names["gpu"] = sname.split(':')[-1].strip() if ':' in sname else sname
        return names

    def get_hw_names(self):
        if self._hw_names is None:
            try:
                readings = self._read_shared_memory()
                self._hw_names = self._extract_hw_names(readings)
            except OSError:
                return {"cpu": "CPU", "gpu": "GPU", "mem": "Memory", "disk": "Disk Status"}
        return self._hw_names

    def get_hw_detail(self, gpu_index=None):
        info = {"cpu": {"name": "CPU", "sensors": {}}, "gpu": {"name": "GPU", "sensors": {}}, "mem": {"name": "Memory", "sensors": {}}}
        try:
            readings = self._read_shared_memory()
        except OSError:
            return info
        names = self._extract_hw_names(readings) if self._hw_names is None else self._hw_names
        self._hw_names = names
        info["cpu"]["name"] = names.get("cpu", "CPU")
        info["gpu"]["name"] = names.get("gpu", "GPU")
        info["mem"]["name"] = names.get("mem", "Memory")

        cpu_sensor_names = set()
        gpu_sensor_names = set()
        for r in readings:
            sl = r['sensor_name'].lower()
            if 'cpu' in sl:
                cpu_sensor_names.add(r['sensor_idx'])
            if 'gpu' in sl or 'geforce' in sl or 'radeon' in sl:
                gpu_sensor_names.add(r['sensor_idx'])

        for r in readings:
            if r['value'] is None:
                continue
            key = f"{r['type']}_{r['label'].lower()}"
            if r['sensor_idx'] in cpu_sensor_names:
                info["cpu"]["sensors"][key] = round(float(r['value']), 2)
            elif r['sensor_idx'] in gpu_sensor_names:
                info["gpu"]["sensors"][key] = round(float(r['value']), 2)

        vm = psutil.virtual_memory()
        info["mem"]["total_gb"] = round(vm.total / 1073741824, 1)
        return info

    # ---- 原始传感器树（自选数据卡片）----
    #
    # ident 格式: "{sensor_name}|{type}|{label}"（均取 str()）。
    # 共享内存中同键读数去重保留首条，运行时同样按枚举顺序首匹配。

    def get_sensor_groups(self) -> list:
        try:
            readings = self._read_shared_memory()
        except OSError as e:
            logger.warning("HWiNFO sensor catalog unavailable: {}", e)
            return []
        groups = []
        index = {}   # 组名 -> 组 dict
        seen = set()
        for r in readings:
            rtype = r['type']
            label = r['label']
            if not rtype or not label:
                continue
            ident = f"{r['sensor_name']}|{rtype}|{label}"
            if ident in seen:
                continue
            seen.add(ident)
            item = {
                "key": "raw:" + ident,
                "label": label,
                "kind": hwinfo_sensor_kind(rtype, r.get('unit') or ''),
            }
            if rtype == 8 and r.get('unit'):
                item["unit"] = r['unit']   # OTHER 类型无固定单位，透传原生单位
            group = index.get(r['sensor_name'])
            if group is None:
                group = {"name": r['sensor_name'], "items": []}
                index[r['sensor_name']] = group
                groups.append(group)
            group["items"].append(item)
        return groups

    def get_sensor_value(self, ident: str):
        parts = str(ident or "").split("|")
        if len(parts) != 3:
            return None
        want_sensor, want_type, want_label = (p.lower() for p in parts)
        try:
            readings = self._read_shared_memory()
        except OSError:
            return None
        for r in readings:
            if (r['sensor_name'].lower() == want_sensor
                    and str(r['type']) == want_type
                    and r['label'].lower() == want_label):
                v = r['value']
                try:
                    return float(v) if v is not None else None
                except (TypeError, ValueError):
                    return None
        return None
