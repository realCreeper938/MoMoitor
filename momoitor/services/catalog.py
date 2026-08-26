"""自选数据卡片的数据目录 —— 标准指标能力表与原始传感器 kind 映射。

每个数据源（LHM/HWiNFO/WMI/AIDA64）能提供的"标准指标"不同（如 WMI 无温度/功耗），
此处维护静态能力矩阵；原始传感器树由各后端自行枚举（get_sensor_groups）。

槽位 key 约定（与前端 customcards.js 及 HardwareService.read_value 共同遵守）：
- "std:{group}.{field}"  标准指标，运行时取该源最近一次快照中的对应字段
- "raw:{ident}"          原始传感器，ident 由各后端自定义，运行时反查实时值
"""

# 数据源固定展示顺序（与 services.hardware._BACKENDS 对应）
SOURCE_ORDER = ("lhm", "hwinfo", "wmi", "aida64")

# 数据源显示名（专有名词，不分语言；与 settings.js _DATASOURCE_LABELS 一致）
SOURCE_LABELS = {
    "lhm": "LibreHardwareMonitor",
    "hwinfo": "HWiNFO",
    "wmi": "WMI",
    "aida64": "AIDA64",
}

_ALL_SOURCES = SOURCE_ORDER

# 标准指标定义：key -> (前端 i18n label_key, kind)
# kind 决定前端的单位与格式：pct/temp/power/clock/volt/gb/rate
_STD_FIELDS = {
    "cpu.load": ("std-cpu-load", "pct"),
    "cpu.temp": ("std-cpu-temp", "temp"),
    "cpu.power": ("std-cpu-power", "power"),
    "cpu.clock": ("std-cpu-clock", "clock"),
    "cpu.voltage": ("std-cpu-voltage", "volt"),
    "gpu.load": ("std-gpu-load", "pct"),
    "gpu.temp": ("std-gpu-temp", "temp"),
    "gpu.power": ("std-gpu-power", "power"),
    "gpu.vram_used_gb": ("std-gpu-vram-used", "gb"),
    "gpu.vram_total_gb": ("std-gpu-vram-total", "gb"),
    "gpu.vram_temp": ("std-gpu-vram-temp", "temp"),
    "mem.percent": ("std-mem-percent", "pct"),
    "mem.used_gb": ("std-mem-used", "gb"),
    "mem.total_gb": ("std-mem-total", "gb"),
    "mem.temp": ("std-mem-temp", "temp"),
    "mem.volt": ("std-mem-volt", "volt"),
    "mem.clock": ("std-mem-clock", "clock"),
    "disk_status.activity": ("std-disk-activity", "pct"),
    "disk_status.temp": ("std-disk-temp", "temp"),
    "disk_status.read": ("std-disk-read", "rate"),
    "disk_status.write": ("std-disk-write", "rate"),
    "net.down": ("std-net-down", "rate"),
    "net.up": ("std-net-up", "rate"),
}

# 各数据源可提供的标准指标（依据各后端 snapshot 实现整理；
# 标注为可用的项在个别机器上仍可能取不到值，前端显示 "--" 即可）。
_STD_AVAIL = {
    "lhm": frozenset(_STD_FIELDS),
    "hwinfo": frozenset(_STD_FIELDS),
    "wmi": frozenset((
        "cpu.load", "cpu.clock",
        "gpu.load",
        "mem.percent", "mem.used_gb", "mem.total_gb",
        "disk_status.activity",
        "net.down", "net.up",
    )),
    # aida64 不提供显存总容量 ID（vram_total_gb 恒为空）
    "aida64": frozenset(_STD_FIELDS) - {"gpu.vram_total_gb"},
}


def std_group(source: str) -> dict:
    """构建某数据源的标准指标目录组。items 带 i18n key，由前端翻译标签。"""
    avail = _STD_AVAIL.get(source, frozenset())
    items = []
    for key, (label_key, kind) in _STD_FIELDS.items():
        if key in avail:
            items.append({"key": f"std:{key}", "label_key": label_key, "kind": kind})
    return {"name": "__std__", "items": items}


def lhm_sensor_kind(stype: str) -> str:
    """LibreHardwareMonitor SensorType -> 前端 kind。"""
    return {
        "Voltage": "volt",
        "Clock": "clock",
        "Frequency": "clock",
        "Temperature": "temp",
        "Load": "pct",
        "Control": "pct",
        "Level": "pct",
        "Fan": "rpm",
        "Power": "power",
        "Data": "gb",
        "SmallData": "mb",
        "Throughput": "rate",
    }.get(stype, "raw")


def hwinfo_sensor_kind(rtype: int, unit: str) -> str:
    """HWiNFO 读数类型 -> 前端 kind。OTHER(8) 依单位字符串判断是否速率。"""
    known = {
        1: "temp",   # TEMP
        2: "volt",   # VOLT
        3: "rpm",    # FAN
        5: "power",  # POWER
        6: "clock",  # CLOCK
        7: "pct",    # USAGE
    }
    if rtype in known:
        return known[rtype]
    if rtype == 8 and isinstance(unit, str) and unit.strip().endswith("/s"):
        return "rate"
    return "raw"


def build_source_entry(source: str, raw_groups: list) -> dict:
    """组装单个数据源的目录条目：显示名 + 标准指标组 + 原始传感器组。"""
    groups = [std_group(source)]
    for g in raw_groups or []:
        if isinstance(g, dict) and g.get("name") and g.get("items"):
            groups.append({"name": str(g["name"]), "items": g["items"]})
    return {
        "source": source,
        "label": SOURCE_LABELS.get(source, source),
        "groups": groups,
    }
