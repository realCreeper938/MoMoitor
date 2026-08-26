"""硬件监视服务 —— 线程安全地封装后端监视器，提供快照查询与后端切换。"""

import math
import threading

from loguru import logger

from momoitor.backends import LHMMonitor, HWiNFOMonitor, WMIMonitor, AIDA64Monitor
from momoitor.backends.composite import CompositeMonitor
from momoitor.config import save_settings
from momoitor.services.catalog import SOURCE_ORDER, build_source_entry


_EMPTY_SNAPSHOT = {
    "cpu": {"clock": None, "temp": None, "power": None, "load": None, "voltage": None},
    "gpu": {"temp": None, "power": None, "vram_used_gb": None, "vram_total_gb": None, "load": None, "vram_temp": None},
    "mem": {"used_gb": 0, "total_gb": 0, "percent": 0, "temp": None, "volt": None, "clock": None},
    "disks": [],
    "disk_status": {"activity": None, "temp": None, "read": None, "write": None},
    "net": {"up": 0, "down": 0, "name": "N/A"},
}


_BACKENDS = {
    "lhm": LHMMonitor,
    "hwinfo": HWiNFOMonitor,
    "wmi": WMIMonitor,
    "aida64": AIDA64Monitor,
}


def _sources_from_settings(settings: dict) -> list:
    """从设置中提取启用的数据源顺序列表 [source_name, ...]。"""
    sources = settings.get("general", {}).get("data_sources")
    if not isinstance(sources, list) or not sources:
        legacy = settings.get("general", {}).get("data_source", "lhm")
        return [legacy]
    return [
        item["source"] for item in sources
        if isinstance(item, dict) and item.get("enabled") and item.get("source") in _BACKENDS
    ]


def build_monitor(source_names: list):
    """按优先级构造监视器：单个源直接返回该后端，多个源用 CompositeMonitor。"""
    monitors = []
    for name in source_names:
        if name not in _BACKENDS:
            continue
        monitors.append((name, _BACKENDS[name]()))
    if not monitors:
        monitors = [("lhm", _BACKENDS["lhm"]())]
    if len(monitors) == 1:
        return monitors[0][1]
    return CompositeMonitor(monitors)


def _monitors_map(monitor, source_names: list) -> dict:
    """提取 名称 -> 后端实例 的映射（含单后端与聚合两种情况）。

    聚合后端内部保存 [(name, mon), ...]；单后端则直接把当前启用的唯一源
    映射到该实例。该映射用于按源精确定位标准指标 / 原始传感器值。
    """
    pairs = getattr(monitor, "_monitors", None)
    if pairs:
        return dict(pairs)
    name = source_names[0] if source_names else "lhm"
    return {name: monitor}


class HardwareService:
    """围绕硬件监视后端的线程安全包装类。"""

    def __init__(self, monitor, settings: dict):
        self._monitor = monitor
        self._lock = threading.RLock()
        self._settings = settings
        self._source_names = _sources_from_settings(settings)
        self._mon_map = _monitors_map(monitor, self._source_names)
        self._source_snaps = {}   # 按源最近一次快照缓存（read_value 用）
        self._closed = False

    def snapshot(self, skip_net=False) -> dict:
        try:
            gpu_index = self._settings.get("display", {}).get("gpu_index", 0)
            with self._lock:
                data = self._sanitize(self._monitor.snapshot(gpu_index=gpu_index, skip_net=skip_net))
                self._cache_source_snaps(data)
            data["error"] = ""
            data["unavailable_sources"] = self._unavailable_sources(data)
            return data
        except Exception as e:
            logger.error("snapshot() failed: {}", e)
            data = {**_EMPTY_SNAPSHOT, "error": str(e)}
            data["unavailable_sources"] = list(self._source_names)
            return data

    def _cache_source_snaps(self, data: dict):
        """缓存本次快照的按源明细，供 read_value 精确取某源的值。

        聚合后端内部已记录各源快照；单后端直接用整体快照（含融合后的字段）。
        """
        getter = getattr(self._monitor, "get_source_snapshots", None)
        snaps = getter() if callable(getter) else None
        if not isinstance(snaps, dict):
            snaps = {self._source_names[0]: data} if self._source_names else {}
        self._source_snaps = snaps

    def _unavailable_sources(self, data: dict) -> list:
        """从快照中提取不可用的数据源名。

        聚合后端会在快照里带上失败的源；单后端快照本身没有该字段——
        若快照内容整体为空（没有任何有效数据），则视为当前源不可用。
        """
        if data.get("unavailable_sources"):
            return data["unavailable_sources"]
        has_data = bool(
            data.get("disks")
            or data.get("mem", {}).get("total_gb")
            or data.get("cpu", {}).get("load") is not None
            or data.get("gpu", {}).get("load") is not None
        )
        if not has_data:
            return list(self._source_names)
        return []

    def get_hw_names(self) -> dict:
        try:
            with self._lock:
                return self._monitor.get_hw_names()
        except Exception as e:
            logger.error("get_hw_names failed: {}", e)
            return {"cpu": "CPU", "gpu": "GPU", "mem": "Memory", "disk": "Disk Status"}

    def get_gpu_list(self) -> list:
        try:
            with self._lock:
                return self._monitor.get_gpu_list()
        except Exception as e:
            logger.error("get_gpu_list failed: {}", e)
            return []

    def get_hw_detail(self) -> dict:
        try:
            gpu_index = self._settings.get("display", {}).get("gpu_index", 0)
            with self._lock:
                return self._sanitize(self._monitor.get_hw_detail(gpu_index=gpu_index))
        except Exception as e:
            logger.error("get_hw_detail failed: {}", e)
            return {"cpu": {}, "gpu": {}, "mem": {}}

    def get_backend_info(self) -> dict:
        """后端名称 + 版本（关于页显示）。"""
        try:
            with self._lock:
                return self._monitor.get_backend_info()
        except Exception:
            return {"name": " + ".join(self._source_names) or "None", "version": None}

    def get_data_catalog(self) -> dict:
        """自选数据卡片编辑器目录：当前启用的数据源 × (标准指标 + 原始传感器树)。"""
        sources = []
        for name in SOURCE_ORDER:
            if name not in self._mon_map:
                continue
            raw_groups = []
            mon = self._mon_map.get(name)
            try:
                raw_groups = mon.get_sensor_groups()
            except Exception as e:
                logger.warning("{} get_sensor_groups failed: {}", name, e)
            sources.append(build_source_entry(name, raw_groups))
        return {"sources": sources}

    def read_value(self, source, key):
        """解析自选数据槽位（某源 + key）的实时值；不可用时返回 None。

        - "std:{group}.{field}"：取该源最近一次快照中的标准指标字段；
        - "raw:{ident}"：交给该后端反查原始传感器实时值。
        """
        try:
            key = str(key or "")
            if not source or source not in self._mon_map:
                return None
            if key.startswith("std:"):
                snap = self._source_snaps.get(source)
                if not snap:
                    return None
                group, _, field = key[4:].partition(".")
                val = snap.get(group)
                val = val.get(field) if isinstance(val, dict) else None
                if isinstance(val, bool) or not isinstance(val, (int, float)):
                    return None
                return float(val)
            if key.startswith("raw:"):
                v = self._mon_map.get(source).get_sensor_value(key[4:])
                return float(v) if isinstance(v, (int, float)) else None
        except Exception as e:
            logger.warning("read_value failed for {} / {}: {}", source, key, e)
        return None


    def change_backend(self, sources) -> bool:
        """按新数据源列表重建监视器。sources: [{source, enabled}, ...] 顺序即优先级。"""
        new_names = []
        for item in sources or []:
            if isinstance(item, dict) and item.get("enabled"):
                src = item.get("source")
                if src in _BACKENDS:
                    new_names.append(src)
        if not new_names:
            new_names = ["lhm"]
        if new_names == self._source_names:
            return True
        new_monitor = build_monitor(new_names)
        with self._lock:
            old_monitor = self._monitor
            self._monitor = new_monitor
            self._source_names = new_names
            self._mon_map = _monitors_map(new_monitor, new_names)
            self._source_snaps = {}
            self._closed = False
            try:
                old_monitor.close()
            except Exception as e:
                logger.warning("Failed to close previous backend: {}", e)
        self._settings.setdefault("general", {})["data_sources"] = [
            {"source": s, "enabled": True} for s in new_names
        ]
        self._settings["general"]["data_source"] = new_names[0]
        save_settings(self._settings)
        logger.info("Switched data sources: {}", " + ".join(new_names))
        return True

    def close(self):
        with self._lock:
            if not self._closed:
                self._monitor.close()
                self._closed = True

    @staticmethod
    def _sanitize(obj):
        """单遍剥离嵌套结构中的 NaN/Inf 浮点值。
        当不存在 NaN/Inf 时原样返回对象，避免在热快照路径上不必要的
        dict/list 重建。
        """
        if isinstance(obj, float):
            return None if (math.isinf(obj) or math.isnan(obj)) else obj
        if isinstance(obj, dict):
            result = {}
            changed = False
            for k, v in obj.items():
                sv = HardwareService._sanitize(v)
                if sv is not v:
                    changed = True
                result[k] = sv
            return result if changed else obj
        if isinstance(obj, list):
            result = []
            changed = False
            for v in obj:
                sv = HardwareService._sanitize(v)
                if sv is not v:
                    changed = True
                result.append(sv)
            return result if changed else obj
        return obj
