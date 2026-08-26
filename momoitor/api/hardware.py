"""API 硬件/系统 mixin —— 硬件数据快照、系统信息、进程与端口。

HardwareMixin 提供硬件监控（CPU/GPU/内存/磁盘/网络优先转发给 HardwareService）、
系统时间/信息、进程排序与终止、监听端口、内存清理等能力，
配合 api/__init__.py 的 Api 组合使用。
"""

import ctypes

from loguru import logger

from momoitor.api._util import safe
from momoitor.services.system import (clean_memory, get_sysinfo,
                                      get_system_theme_mode,
                                      get_top_processes, kill_process,
                                      scan_listening_ports)


class HardwareMixin:
    """硬件数据与系统信息的 JS 桥接方法。"""

    def get_data(self, skip_net=False):
        return self._hw.snapshot(skip_net=skip_net)

    def get_hw_names(self):
        return self._hw.get_hw_names()

    def get_gpu_list(self):
        return self._hw.get_gpu_list()

    def get_hw_detail(self):
        return self._hw.get_hw_detail()

    def get_data_catalog(self):
        """自选数据卡片目录：当前启用的数据源 × (标准指标 + 原始传感器树)。

        返回 {"sources": [{"source", "label", "groups": [{"name", "items": [...]}]}]}。
        items 的 key 形如 "std:{group}.{field}" 或 "raw:{ident}"。
        """
        return self._hw.get_data_catalog()

    def get_custom_values(self, slots):
        """批量解析自选数据槽位的实时值。

        slots: [{"source", "key"}, ...]，逐项对应返回 [float|None, ...]。
        槽位数量有上限保护，避免异常输入导致超大遍历。
        """
        if not isinstance(slots, list):
            return []
        out = []
        for s in slots[:500]:
            if not isinstance(s, dict):
                out.append(None)
                continue
            out.append(self._hw.read_value(s.get("source"), s.get("key")))
        return out

    def change_backend(self, source):
        return self._hw.change_backend(source)

    def get_system_theme_mode(self):
        return get_system_theme_mode()

    def get_sysinfo(self):
        return get_sysinfo()

    def get_top_processes(self, sort_by="cpu", limit=1):
        return get_top_processes(sort_by, limit)

    def kill_process(self, pid):
        return kill_process(int(pid))

    def get_listening_ports(self):
        return scan_listening_ports()

    @safe("clean_memory", {"ok": False}, include_error=True)
    def clean_memory(self, deep=False):
        """回收所有进程的工作集 —— 点击内存占用百分比时触发。
        deep=True（快速重复点击）更激进地刷新工作集。"""
        return clean_memory(bool(deep))

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