"""数据源插件需要继承的监视器基类。

插件在 register(ctx) 中调用 ctx.register_data_source(config, Monitor) 注册
一个数据源，其中 Monitor 继承 PluginMonitor。该类的 snapshot() 会被
MoMoitor 以固定频率调用，返回与内置后端一致结构的数据字典。

快照结构（与 backends/base.py 一致）:
    {
        "cpu":   {"clock", "temp", "power", "load", "voltage"},
        "gpu":   {"temp", "power", "load", "vram_used_gb", "vram_total_gb", "vram_temp"},
        "mem":   {"used_gb", "total_gb", "percent", "temp", "volt", "clock"},
        "disks": [{"letter", "used_gb", "total_gb", "percent"}],
        "disk_status": {"activity", "temp", "read", "write"},
        "net":   {"up", "down", "name"},
    }

所有数值字段允许为 None（表示无法获取），前台会显示为 "--"。
"""

from abc import ABC, abstractmethod


class PluginMonitor(ABC):
    """数据源插件的监视器基类。

    子类只需实现 snapshot()；其余方法已有合理默认值，按需覆写即可。
    """

    def close(self):
        """退出时调用，用于释放资源。默认无操作。"""

    def get_backend_info(self) -> dict:
        """返回 {name, version}，显示在「关于」页。"""
        return {"name": self.__class__.__name__, "version": None}

    def get_hw_names(self) -> dict:
        """返回硬件名称 {cpu, gpu, mem, disk}，显示在卡片标题。"""
        return {"cpu": "CPU", "gpu": "GPU", "mem": "Memory", "disk": "Disk Status"}

    def get_gpu_list(self) -> list:
        """返回 GPU 名称列表，用于设置页的 GPU 下拉框。"""
        return []

    def get_hw_detail(self, gpu_index=None) -> dict:
        """返回硬件详情 {cpu, gpu, mem}（名称/核心数等静态信息）。"""
        return {"cpu": {}, "gpu": {}, "mem": {}}

    def get_memory(self) -> dict:
        """单独的内存信息。默认从 snapshot() 中取出 mem 字段。"""
        return self.snapshot().get("mem", {})

    @abstractmethod
    def snapshot(self, gpu_index=None) -> dict:
        """返回一次硬件快照（结构见模块文档）。必须由子类实现。"""
        raise NotImplementedError
