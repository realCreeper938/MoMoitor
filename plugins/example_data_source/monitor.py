"""示例数据源：随机抖动数据

继承 PluginMonitor 并实现 snapshot() 即可作为 MoMoitor 的硬件后端。
所有可选的辅助方法（get_backend_info / get_hw_names / close ...）
都有默认实现，可按需覆写。
"""

import random
import time

from momoitor.plugins.monitor import PluginMonitor


class Monitor(PluginMonitor):
    """一个产生平滑随机数据的假硬件后端，用于演示插件数据源。"""

    def __init__(self):
        self._last = time.time()
        self._load = 50.0

    def get_backend_info(self):
        return {"name": "Demo", "version": "1.0.0"}

    def get_hw_names(self):
        return {
            "cpu": "Demo CPU",
            "gpu": "Demo GPU",
            "mem": "Demo RAM",
            "disk": "Demo Disk",
        }

    def get_gpu_list(self):
        return [{"name": "Demo GPU", "index": 0}]

    def snapshot(self, gpu_index=None):
        """返回一次硬件快照，结构与内置后端的 snapshot() 保持一致。"""
        now = time.time()
        dt = max(now - self._last, 0.001)
        self._last = now

        # 让负载平滑波动（缓慢游走 + 小抖动）
        self._load += random.uniform(-8, 8)
        self._load = max(3, min(97, self._load))
        gpu_load = max(3, min(97, self._load + random.uniform(-20, 20)))
        mem_percent = random.uniform(20, 85)

        return {
            "cpu": {
                "clock": 4000 + random.uniform(-300, 300),
                "temp": 45 + self._load * 0.35,
                "power": 15 + self._load * 0.9,
                "load": self._load,
                "voltage": 1.25 + random.uniform(-0.03, 0.03),
            },
            "gpu": {
                "temp": 40 + gpu_load * 0.4,
                "power": 20 + gpu_load,
                "load": gpu_load,
                "vram_used_gb": random.uniform(2, 9),
                "vram_total_gb": 12,
                "vram_temp": 50 + gpu_load * 0.3,
            },
            "mem": {
                "used_gb": mem_percent * 0.16,
                "total_gb": 16,
                "percent": mem_percent,
                "temp": 0,
                "volt": 0,
                "clock": 3200,
            },
            "disks": [
                {
                    "letter": "C",
                    "used_gb": 120 + random.uniform(-1, 1),
                    "total_gb": 256,
                    "percent": 47,
                },
                {
                    "letter": "D",
                    "used_gb": 300 + random.uniform(-1, 1),
                    "total_gb": 1024,
                    "percent": 29,
                },
            ],
            "disk_status": {
                "activity": random.random() < 0.3,
                "temp": random.uniform(25, 45),
                "read": random.uniform(0, 100),
                "write": random.uniform(0, 60),
            },
            "net": {
                "up": random.uniform(0, 4000),
                "down": random.uniform(0, 8000),
                "name": "demo",
            },
        }
