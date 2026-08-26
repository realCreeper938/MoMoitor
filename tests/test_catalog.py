"""自选数据卡片数据目录与按源取值功能的单测。

不初始化任何真实后端（LHM/.NET、HWiNFO 共享内存），全部用假后端对象隔离，
验证 get_data_catalog / read_value 的核心契约：
- 目录只包含启用的数据源；
- 标准指标标签与 kind 映射正确；
- 原始传感器分组透传；
- read_value 按"源 + key"精确定位，未启用源 / 无效 key 返回 None。
"""

from momoitor.services.catalog import (
    SOURCE_ORDER,
    SOURCE_LABELS,
    lhm_sensor_kind,
    hwinfo_sensor_kind,
    build_source_entry,
)
from momoitor.services.hardware import HardwareService, _monitors_map


class _FakeMon:
    def __init__(self, id_=None):
        self._name = id_ or "fake"

    def snapshot(self, gpu_index=None, skip_net=False):
        return {"cpu": {"load": 10}, "mem": {"percent": 50}}

    def get_sensor_groups(self):
        return [{"name": "CPU", "items": [{"key": "raw:x|core", "label": "Core #1", "kind": "temp"}]}]

    def get_sensor_value(self, ident):
        return 66.0 if ident == "x|core" else None

    def get_hw_names(self):
        return {}

    def get_hw_detail(self, gpu_index=None):
        return {}

    def get_gpu_list(self):
        return []

    def get_backend_info(self):
        return {"name": "fake", "version": None}

    def close(self):
        pass


class _FakeComposite:
    """行为与 CompositeMonitor 一致的假聚合后端（含 _monitors 与按源快照）。"""

    def __init__(self, source_names):
        self._monitors = [(n, _FakeMon(n)) for n in source_names]
        self._failed_sources = []
        self._last_snaps = {n: {"cpu": {"load": 10}, "mem": {"percent": 50}} for n in source_names}

    def get_source_snapshots(self):
        return dict(self._last_snaps)

    def get_hw_names(self):
        return {}

    def get_hw_detail(self, gpu_index=None):
        return {}

    def get_gpu_list(self):
        return []

    def get_backend_info(self):
        return {"name": "comp", "version": None}


def test_source_order_and_labels():
    assert list(SOURCE_ORDER) == ["lhm", "hwinfo", "wmi", "aida64"]
    assert SOURCE_LABELS["lhm"] == "LibreHardwareMonitor"


def test_sensor_kind_mapping():
    assert lhm_sensor_kind("Temperature") == "temp"
    assert lhm_sensor_kind("Power") == "power"
    assert lhm_sensor_kind("Load") == "pct"
    assert lhm_sensor_kind("UnknownType") == "raw"
    assert hwinfo_sensor_kind(1, "") == "temp"      # TEMP
    assert hwinfo_sensor_kind(5, "") == "power"     # POWER
    assert hwinfo_sensor_kind(7, "") == "pct"       # USAGE
    assert hwinfo_sensor_kind(8, "MB/s") == "rate"  # OTHER rate unit
    assert hwinfo_sensor_kind(8, "GB") == "raw"     # OTHER non-rate unit


def test_std_group_avail_filtered():
    from momoitor.services.catalog import std_group

    lhm = std_group("lhm").get("items")
    wmi = std_group("wmi").get("items")
    lhm_keys = {it["key"] for it in lhm}
    wmi_keys = {it["key"] for it in wmi}
    assert "std:cpu.temp" in lhm_keys
    assert "std:cpu.temp" not in wmi_keys          # WMI 无温度
    assert "std:cpu.load" in wmi_keys
    assert "std:gpu.vram_total_gb" in lhm_keys
    assert "std:gpu.vram_total_gb" not in {it["key"] for it in std_group("aida64")["items"]}


def test_build_source_entry_includes_raw_groups():
    raw = [{"name": "GPU", "items": [{"key": "raw:gpu", "label": "Core", "kind": "temp"}]}]
    entry = build_source_entry("lhm", raw)
    assert entry["source"] == "lhm"
    assert entry["label"] == "LibreHardwareMonitor"
    assert entry["groups"][0]["name"] == "__std__"
    assert entry["groups"][1]["name"] == "GPU"
    assert entry["groups"][1]["items"][0]["key"] == "raw:gpu"


def test_read_value_by_source_and_key():
    comp = _FakeComposite(["lhm", "hwinfo"])
    svc = HardwareService(comp, {"general": {"data_sources": [
        {"source": "lhm", "enabled": True},
        {"source": "hwinfo", "enabled": True},
    ]}})
    svc._source_snaps = {
        "lhm": {"cpu": {"load": 11}, "mem": {"percent": 51}},
        "hwinfo": {"cpu": {"load": 22}, "mem": {"percent": 52}},
    }
    assert svc.read_value("lhm", "std:cpu.load") == 11.0
    assert svc.read_value("hwinfo", "std:cpu.load") == 22.0
    assert svc.read_value("wmi", "std:cpu.load") is None          # 未启用源
    assert svc.read_value("lhm", "std:cpu.zzz") is None           # 未知字段
    assert svc.read_value("lhm", "raw:x|core") == 66.0            # 原始传感器
    assert svc.read_value("lhm", "raw:none") is None


def test_get_data_catalog_only_enabled():
    comp = _FakeComposite(["lhm", "wmi"])
    svc = HardwareService(comp, {"general": {"data_sources": [
        {"source": "lhm", "enabled": True},
        {"source": "wmi", "enabled": True},
    ]}})
    catalog = svc.get_data_catalog()
    assert [s["source"] for s in catalog["sources"]] == ["lhm", "wmi"]
    assert catalog["sources"][0]["groups"][1]["items"][0]["key"].startswith("raw:")
