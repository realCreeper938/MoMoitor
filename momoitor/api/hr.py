"""心率（BLE）API mixin —— 暴露给前端 JS 的心率读取/扫描/连接接口。"""

from momoitor.api._util import safe
from momoitor.services import hr as hr_svc


class HrMixin:
    @safe("HR get_current", {"connected": False, "bpm": None, "device_name": "", "address": None})
    def get_hr(self):
        """返回当前心率状态：{connected, bpm, device_name, address}。"""
        return hr_svc.get_current()

    @safe("HR scan", [])
    def scan_hr_devices(self, timeout=8):
        """扫描广播心率服务的 BLE 设备，返回 [{name, address, rssi}, ...]。"""
        return hr_svc.scan(int(timeout))

    @safe("HR connect", {"ok": False}, include_error=True)
    def connect_hr(self, address):
        """连接指定地址的设备并订阅心率通知，返回 {"ok": bool, ...}。"""
        return hr_svc.connect(address)

    @safe("HR disconnect", {"ok": False}, include_error=True)
    def disconnect_hr(self):
        """断开当前心率连接。"""
        return hr_svc.disconnect()
