"""心率（BLE）API mixin —— 暴露给前端 JS 的心率读取/扫描/连接接口。"""

from loguru import logger

from momoitor.services import hr as hr_svc


class HrMixin:
    def get_hr(self):
        """返回当前心率状态：{connected, bpm, device_name, address}。"""
        try:
            return hr_svc.get_current()
        except Exception as e:
            logger.warning("HR get_current failed: {}", e)
            return {"connected": False, "bpm": None, "device_name": "", "address": None}

    def scan_hr_devices(self, timeout=8):
        """扫描广播心率服务的 BLE 设备，返回 [{name, address, rssi}, ...]。"""
        try:
            return hr_svc.scan(int(timeout))
        except Exception as e:
            logger.warning("HR scan failed: {}", e)
            return []

    def connect_hr(self, address):
        """连接指定地址的设备并订阅心率通知，返回 {"ok": bool, ...}。"""
        try:
            return hr_svc.connect(address)
        except Exception as e:
            logger.warning("HR connect failed: {}", e)
            return {"ok": False, "error": str(e)}

    def disconnect_hr(self):
        """断开当前心率连接。"""
        try:
            return hr_svc.disconnect()
        except Exception as e:
            logger.warning("HR disconnect failed: {}", e)
            return {"ok": False, "error": str(e)}
