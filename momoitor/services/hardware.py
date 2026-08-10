"""硬件监视服务 —— 线程安全地封装后端监视器，提供快照查询与后端切换。"""

import inspect
import math
import threading

from loguru import logger

from momoitor.backends import LHMMonitor, HWiNFOMonitor
from momoitor.config import save_settings


class HardwareService:
    """围绕硬件监视后端的线程安全包装类。"""

    def __init__(self, monitor, settings: dict, plugin_monitor_factory=None):
        self._monitor = monitor
        self._lock = threading.RLock()
        self._settings = settings
        self._backend_source = settings.get("general", {}).get("data_source", "lhm")
        self._closed = False
        # 插件数据源工厂：给定 source 返回插件 Monitor（无匹配则返回 None）
        self._plugin_monitor_factory = plugin_monitor_factory
        self._snapshot_accepts_skip_net = None

    def snapshot(self, skip_net=False) -> dict:
        try:
            gpu_index = self._settings.get("display", {}).get("gpu_index", 0)
            with self._lock:
                data = self._sanitize(self._call_snapshot(gpu_index, skip_net))
            data["error"] = ""
            return data
        except Exception as e:
            logger.error("snapshot() failed: {}", e)
            return {
                "cpu": {"clock": None, "temp": None, "power": None, "load": None, "voltage": None},
                "gpu": {"temp": None, "power": None, "vram_used_gb": None, "vram_total_gb": None, "load": None, "vram_temp": None},
                "mem": {"used_gb": 0, "total_gb": 0, "percent": 0, "temp": None, "volt": None, "clock": None},
                "disks": [],
                "disk_status": {"activity": None, "temp": None, "read": None, "write": None},
                "net": {"up": 0, "down": 0, "name": "N/A"},
                "error": str(e),
            }

    def _call_snapshot(self, gpu_index, skip_net):
        """按监视器签名调用 snapshot()，兼容未实现 skip_net 的旧插件数据源。"""
        fn = self._monitor.snapshot
        if getattr(self, "_snapshot_accepts_skip_net", None) is None:
            try:
                params = inspect.signature(fn).parameters
                self._snapshot_accepts_skip_net = "skip_net" in params
            except (TypeError, ValueError):
                self._snapshot_accepts_skip_net = False
        if self._snapshot_accepts_skip_net:
            return fn(gpu_index=gpu_index, skip_net=skip_net)
        return fn(gpu_index=gpu_index)

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

    def snapshot_with_detail(self) -> dict:
        """在同一个锁下返回快照与硬件详情。"""
        try:
            gpu_index = self._settings.get("display", {}).get("gpu_index", 0)
            with self._lock:
                data = self._sanitize(self._monitor.snapshot(gpu_index=gpu_index))
                detail = self._sanitize(self._monitor.get_hw_detail(gpu_index=gpu_index))
            data["error"] = ""
            return {"snapshot": data, "detail": detail}
        except Exception as e:
            logger.error("snapshot_with_detail failed: {}", e)
            return {
                "snapshot": {
                    "cpu": {"clock": None, "temp": None, "power": None, "load": None, "voltage": None},
                    "gpu": {"temp": None, "power": None, "vram_used_gb": None, "vram_total_gb": None, "load": None, "vram_temp": None},
                    "mem": {"used_gb": 0, "total_gb": 0, "percent": 0, "temp": None, "volt": None, "clock": None},
                    "disks": [],
                    "disk_status": {"activity": None, "temp": None, "read": None, "write": None},
                    "net": {"up": 0, "down": 0, "name": "N/A"},
                    "error": str(e),
                },
                "detail": {"cpu": {}, "gpu": {}, "mem": {}},
            }

    def get_memory(self) -> dict:
        with self._lock:
            return self._monitor.get_memory()

    def get_backend_info(self) -> dict:
        """后端名称 + 版本（关于页显示）。"""
        try:
            with self._lock:
                return self._monitor.get_backend_info()
        except Exception:
            return {"name": self._backend_source.upper(), "version": None}

    def change_backend(self, source: str) -> bool:
        # 插件提供的数据源：优先尝试，命中则直接切换
        if self._plugin_monitor_factory is not None and source not in ("lhm", "hwinfo"):
            if source == self._backend_source:
                return True
            new_monitor = self._plugin_monitor_factory(source)
            if new_monitor is not None:
                with self._lock:
                    old_monitor = self._monitor
                    self._monitor = new_monitor
                    self._backend_source = source
                    self._closed = False
                    self._snapshot_accepts_skip_net = None
                    try:
                        old_monitor.close()
                    except Exception as e:
                        logger.warning("Failed to close previous backend: {}", e)
                self._settings.setdefault("general", {})["data_source"] = source
                save_settings(self._settings)
                logger.info("Switched to plugin backend {}", source)
                return True
            logger.warning("Plugin backend {} not available, falling back", source)
        source = "hwinfo" if source == "hwinfo" else "lhm"
        if source == self._backend_source:
            return True
        new_monitor = HWiNFOMonitor() if source == "hwinfo" else LHMMonitor()
        with self._lock:
            old_monitor = self._monitor
            self._monitor = new_monitor
            self._backend_source = source
            self._closed = False
            self._snapshot_accepts_skip_net = None
            try:
                old_monitor.close()
            except Exception as e:
                logger.warning("Failed to close previous backend: {}", e)
        self._settings.setdefault("general", {})["data_source"] = source
        save_settings(self._settings)
        logger.info("Switched to {} backend", source)
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
