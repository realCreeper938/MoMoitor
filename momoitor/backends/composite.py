"""多数据源聚合后端 —— 按优先级逐字段合并多个后端的数据。

将若干硬件后端按用户配置的优先级排列；快照时依次采集每个启用的后端，
再逐字段取第一个非空值：高优先级后端缺失的字段自动回退到下一个启用的
后端补齐（字段级 fallback）。
"""

from loguru import logger

from .base import BaseMonitor

# 快照各分组中的标量字段（用于逐字段合并）。
_SCALAR_GROUPS = {
    "cpu": ("clock", "temp", "power", "load", "voltage"),
    "gpu": ("temp", "power", "vram_used_gb", "vram_total_gb", "load", "vram_temp"),
    "mem": ("used_gb", "total_gb", "percent", "temp", "volt", "clock"),
    "disk_status": ("activity", "temp", "read", "write"),
}


class CompositeMonitor(BaseMonitor):
    """按优先级排列的多后端聚合器，字段级 fallback。"""

    def __init__(self, monitors):
        """monitors: [(source_name, BaseMonitor), ...]，顺序即优先级。"""
        super().__init__()
        self._monitors = list(monitors)
        # 最近一次快照中失败的源名（供前端提示）。
        self._failed_sources = []
        # 最近一次快照的按源明细（名称 -> 该源快照），供按源精确定位标准指标值。
        self._last_snaps = {name: None for name, _ in self._monitors}

    def _source_snapshots(self, gpu_index, skip_net):
        """依次采集每个后端的快照；单个后端异常时跳过（该源视为无数据）。"""
        snaps = []
        failed = []
        for name, mon in self._monitors:
            try:
                snap = mon.snapshot(gpu_index=gpu_index, skip_net=skip_net)
                if snap:
                    snaps.append(snap)
                    self._last_snaps[name] = snap
            except Exception as e:
                logger.warning("{} backend snapshot failed: {}", name, e)
                failed.append(name)
                self._last_snaps[name] = None
        self._failed_sources = failed
        return snaps

    def snapshot(self, gpu_index=None, skip_net=False) -> dict:
        snaps = self._source_snapshots(gpu_index, skip_net)
        if not snaps:
            raise RuntimeError("no data source available")

        result = {}
        # 标量字段：按分组逐字段取第一个非空值。
        # 特殊分组：mem 的 total_gb==0 说明该源无内存数据（视为整组缺失）；
        # disk_status 正常取值即可。
        for group, fields in _SCALAR_GROUPS.items():
            merged = {}
            for field in fields:
                for snap in snaps:
                    val = snap.get(group, {}).get(field)
                    if val is None:
                        continue
                    if group == "mem" and field in ("used_gb", "total_gb", "percent") \
                            and not snap.get(group, {}).get("total_gb"):
                        continue
                    merged[field] = val
                    break
                merged.setdefault(field, None)
            result[group] = merged

        # 磁盘分区列表：取第一个非空的后端（同一台机器的分区一致）
        result["disks"] = next(
            (snap["disks"] for snap in snaps if snap.get("disks")), []
        )
        # 网络速率：取第一个提供有效数据（name 非 N/A）后端的整体，
        # 各后端独立累计，不逐字段混用。
        result["net"] = next(
            (snap["net"] for snap in snaps
             if snap.get("net") and snap["net"].get("name") != "N/A"),
            {"up": 0, "down": 0, "name": "N/A"},
        )
        result["unavailable_sources"] = list(self._failed_sources)
        return result

    def get_hw_names(self) -> dict:
        for name, mon in self._monitors:
            try:
                result = mon.get_hw_names()
                if result:
                    return result
            except Exception as e:
                logger.warning("{} get_hw_names failed: {}", name, e)
        return {"cpu": "CPU", "gpu": "GPU", "mem": "Memory", "disk": "Disk Status"}

    def get_gpu_list(self) -> list:
        for name, mon in self._monitors:
            try:
                result = mon.get_gpu_list()
                if result:
                    return result
            except Exception as e:
                logger.warning("{} get_gpu_list failed: {}", name, e)
        return []

    def get_hw_detail(self, gpu_index=None) -> dict:
        for name, mon in self._monitors:
            try:
                result = mon.get_hw_detail(gpu_index=gpu_index)
                if result:
                    return result
            except Exception as e:
                logger.warning("{} get_hw_detail failed: {}", name, e)
        return {"cpu": {}, "gpu": {}, "mem": {}}

    def get_backend_info(self) -> dict:
        """返回聚合后端名称：按优先级列出启用的源。"""
        names = [n for n, _ in self._monitors]
        return {"name": " + ".join(names) if names else "None", "version": None}

    def get_source_snapshots(self) -> dict:
        """最近一次快照的按源明细（名称 -> 该源快照），供按源精确定位标准指标值。"""
        return {k: v for k, v in self._last_snaps.items()}

    def close(self):
        for _, mon in self._monitors:
            try:
                mon.close()
            except Exception as e:
                logger.warning("close backend failed: {}", e)
