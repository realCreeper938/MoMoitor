"""API 硬件/系统 mixin —— 硬件数据快照、系统信息、进程与端口。

HardwareMixin 提供硬件监控（CPU/GPU/内存/磁盘/网络优先转发给 HardwareService）、
系统时间/信息、进程排序与终止、监听端口、内存清理等能力，
配合 api/__init__.py 的 Api 组合使用。
"""

import ctypes

from loguru import logger

from momoitor.services import window as win_svc
from momoitor.services.system import (clean_memory, get_sysinfo,
                                      get_system_theme_mode, get_time,
                                      get_top_processes, kill_process,
                                      scan_listening_ports)


class HardwareMixin:
    """硬件数据与系统信息的 JS 桥接方法。"""

    def get_data(self):
        data = self._hw.snapshot()
        # 插件快照钩子：可在数据返回前端前修改/扩展
        return self._plugin_manager.apply_snapshot_hooks(data)

    def get_hw_names(self):
        return self._hw.get_hw_names()

    def get_gpu_list(self):
        return self._hw.get_gpu_list()

    def get_hw_detail(self):
        return self._hw.get_hw_detail()

    def change_backend(self, source):
        return self._hw.change_backend(source)

    def get_time(self):
        return get_time()

    def get_system_theme_mode(self):
        return get_system_theme_mode()

    def get_sysinfo(self):
        return get_sysinfo()

    def get_idle_time(self):
        return win_svc.get_idle_time()

    def get_top_processes(self, sort_by="cpu", limit=1):
        return get_top_processes(sort_by, limit)

    def kill_process(self, pid):
        return kill_process(int(pid))

    def get_listening_ports(self):
        return scan_listening_ports()

    def clean_memory(self, deep=False):
        """回收所有进程的工作集 —— 点击内存占用百分比时触发。
        deep=True（快速重复点击）更激进地刷新工作集。"""
        try:
            return clean_memory(bool(deep))
        except Exception as e:
            logger.warning("clean_memory failed: {}", e)
            return {"ok": False, "error": str(e)}

    def open_taskmgr(self):
        """启动 Windows 任务管理器并置于前台。"""
        import subprocess
        try:
            # 允许子进程获取前台窗口
            ctypes.windll.user32.AllowSetForegroundWindow(0xFFFFFFFF)
            subprocess.Popen(["taskmgr.exe"])
        except Exception as e:
            logger.warning("open_taskmgr failed: {}", e)

    def open_external(self, url):
        """在系统默认浏览器中打开外部链接。仅允许 http/https。"""
        import webbrowser
        if not url or not url.lower().startswith(("http://", "https://")):
            return False
        try:
            webbrowser.open(url)
            return True
        except Exception as e:
            logger.warning("open_external failed: {}", e)
            return False

    def get_hardware_info(self):
        """把硬件快照 + 详情拼成多行纯文本（设置页「复制诊断信息」等用途）。"""
        combined = self._hw.snapshot_with_detail()
        s = combined.get("snapshot", {})
        d = combined.get("detail", {})
        cpu = s.get("cpu", {})
        gpu = s.get("gpu", {})
        mem = s.get("mem", {})
        disks = s.get("disks", [])
        ds = s.get("disk_status", {})
        net = s.get("net", {})
        lines = []
        cpu_name = d.get("cpu", {}).get("name", "CPU")
        cores = d.get("cpu", {}).get("cores")
        threads = d.get("cpu", {}).get("threads")
        line = f"{cpu_name}"
        if cores: line += f" ({cores}C/{threads}T)" if threads else f" ({cores}C)"
        lines.append(line)
        lines.append(f"  Temp: {cpu.get('temp', '?')}C  Clock: {cpu.get('clock', '?')}MHz  Load: {cpu.get('load', '?')}%  Power: {cpu.get('power', '?')}W  Voltage: {cpu.get('voltage', '?')}V")
        gpu_name = d.get("gpu", {}).get("name", "GPU")
        lines.append(gpu_name)
        lines.append(f"  Temp: {gpu.get('temp', '?')}C  Load: {gpu.get('load', '?')}%  Power: {gpu.get('power', '?')}W")
        vram_u = gpu.get("vram_used_gb")
        vram_t = gpu.get("vram_total_gb")
        if vram_t: lines.append(f"  VRAM: {vram_u}/{vram_t} GB")
        if gpu.get("vram_temp"): lines.append(f"  VRAM Temp: {gpu['vram_temp']}C")
        mem_name = d.get("mem", {}).get("name", "Memory")
        mem_type = d.get("mem", {}).get("type", "")
        mem_speed = d.get("mem", {}).get("speed", "")
        lines.append(f"{mem_name} {mem_type} {mem_speed}")
        lines.append(f"  Used: {mem.get('used_gb', '?')}/{mem.get('total_gb', '?')} GB ({mem.get('percent', '?')}%)")
        if mem.get("temp"): lines.append(f"  Temp: {mem['temp']}C  Clock: {mem.get('clock', '?')}MHz")
        for dk in disks:
            lines.append(f"Disk {dk.get('letter', '?')}: {dk.get('used_gb', '?')}/{dk.get('total_gb', '?')} GB ({dk.get('percent', '?')}%)")
        if ds.get("temp") or ds.get("activity"):
            lines.append(f"Disk Status: Activity={ds.get('activity', '?')}% Temp={ds.get('temp', '?')}C Read={ds.get('read', '?')}B/s Write={ds.get('write', '?')}B/s")
        lines.append(f"Network ({net.get('name', '?')}): ↑{net.get('up', 0)}B/s ↓{net.get('down', 0)}B/s")
        return {"success": True, "info": "\n".join(lines)}