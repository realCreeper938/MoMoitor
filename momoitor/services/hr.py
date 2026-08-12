"""心率监控服务 —— 通过 BLE GATT 订阅心率通知（Heart Rate Service 0x180D / 特征 0x2A37），仅限 Windows。

使用方式：
    from momoitor.services import hr as hr_svc
    hr_svc.start()          # 启动事件循环，并按设置自动重连已保存的设备
    hr_svc.scan(8)          # 扫描广播心率服务的 BLE 设备
    hr_svc.connect(addr)    # 连接并订阅心率通知
    hr_svc.disconnect()     # 断开连接
    hr_svc.get_current()    # {connected, bpm, device_name, address}
"""

import asyncio
import sys
import threading
import time
import uuid

from loguru import logger

HR_SERVICE_UUID = uuid.UUID("0000180d-0000-1000-8000-00805f9b34fb")
HR_SERVICE_UUID_STR = str(HR_SERVICE_UUID)
HR_MEASUREMENT_UUID = uuid.UUID("00002a37-0000-1000-8000-00805f9b34fb")
SCAN_DEFAULT_SECONDS = 8
# 超过该时长未收到心率数据则视为已断开（前端显示 --）
STALE_SECONDS = 8.0

_state = {"connected": False, "bpm": None, "device_name": "", "address": None}
_last_update = 0.0
_lock = threading.Lock()
_start_lock = threading.Lock()
_loop = None
_loop_thread = None
_device = None
_service = None
_characteristic = None
_notify_token = None


def _clean_name(name):
    """清洗设备名：还原以 Latin-1 错解码的 UTF-8 字节，并过滤不可打印字符（含孤立代理项），避免界面乱码。"""
    if not name:
        return ""
    cleaned = name
    try:
        raw_bytes = name.encode("latin-1")
        try:
            cleaned = raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            pass
    except UnicodeEncodeError:
        pass
    try:
        return "".join(c for c in cleaned if c.isprintable()).strip()
    except Exception:
        return cleaned


def start():
    """启动后台事件循环线程；若设置中保存了设备地址则自动重连。幂等。"""
    global _loop, _loop_thread
    with _start_lock:
        if _loop is not None:
            return
        if sys.platform != "win32":
            logger.info("Heart rate service skipped (not Windows)")
            return
        _loop = asyncio.new_event_loop()
        _loop_thread = threading.Thread(target=_loop.run_forever, daemon=True, name="hr-bt-loop")
        _loop_thread.start()
        logger.info("Heart rate service started")
        addr = _configured_address()
        if addr is not None:
            _submit(_connect_async(addr), "auto reconnect")


def stop():
    """断开连接并停止事件循环。"""
    global _loop
    loop = _loop
    if loop is None:
        return
    try:
        asyncio.run_coroutine_threadsafe(_disconnect_async(), loop).result(timeout=5)
    except Exception:
        pass
    try:
        loop.call_soon_threadsafe(loop.stop)
    except Exception:
        pass
    _loop = None


def _configured_address():
    from momoitor.config import load_settings
    hr = load_settings().get("hr", {}) or {}
    raw = hr.get("device_address") or ""
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _submit(coro, what=""):
    loop = _loop
    if loop is None:
        start()
        loop = _loop
    if loop is None:
        return None
    try:
        return asyncio.run_coroutine_threadsafe(coro, loop)
    except Exception as e:
        logger.warning("HR {} submit failed: {}", what, e)
        return None


def scan(timeout=SCAN_DEFAULT_SECONDS):
    """扫描广播心率服务的 BLE 设备，返回 [{name, address, rssi}, ...]（按信号强度排序）。"""
    if sys.platform != "win32":
        return []
    fut = _submit(_scan_async(int(timeout)), "scan")
    if fut is None:
        return []
    try:
        return fut.result(timeout=int(timeout) + 8)
    except Exception as e:
        logger.warning("HR scan failed: {}", e)
        return []


async def _scan_async(timeout):
    from winrt.windows.devices.bluetooth.advertisement import (
        BluetoothLEAdvertisementWatcher,
        BluetoothLEScanningMode,
    )
    found = {}
    watcher = BluetoothLEAdvertisementWatcher()
    watcher.scanning_mode = BluetoothLEScanningMode.ACTIVE

    def on_received(sender, args):
        adv = args.advertisement
        uuids = set()
        try:
            for u in adv.service_uuids:
                uuids.add(str(u).lower())
        except Exception:
            pass
        if HR_SERVICE_UUID_STR not in uuids:
            return
        addr = args.bluetooth_address
        name = _clean_name(getattr(adv, "local_name", "") or "")
        with _lock:
            old = found.get(addr)
            if old is None or (not old["name"] and name):
                found[addr] = {
                    "name": name,
                    "address": addr,
                    "rssi": args.raw_signal_strength_in_dbm,
                }

    token = watcher.add_received(on_received)
    try:
        watcher.start()
        await asyncio.sleep(timeout)
    finally:
        try:
            watcher.stop()
        except Exception:
            pass
        try:
            watcher.remove_received(token)
        except Exception:
            pass
    with _lock:
        result = sorted(found.values(), key=lambda d: d.get("rssi", -999), reverse=True)
    return result


def connect(address):
    """连接设备地址并订阅心率通知，返回 {"ok": bool, ...}。"""
    try:
        addr = int(address)
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad address"}
    fut = _submit(_connect_async(addr), "connect")
    if fut is None:
        return {"ok": False, "error": "service unavailable"}
    try:
        return fut.result(timeout=20)
    except Exception as e:
        logger.warning("HR connect failed: {}", e)
        return {"ok": False, "error": str(e)}


async def _connect_async(addr):
    global _device, _service, _characteristic, _notify_token
    await _disconnect_async()
    device = None
    try:
        from winrt.windows.devices.bluetooth import BluetoothLEDevice
        from winrt.windows.devices.bluetooth.genericattributeprofile import (
            GattClientCharacteristicConfigurationDescriptorValue as Ccd,
        )

        device = await BluetoothLEDevice.from_bluetooth_address_async(addr)
        # 与参考实现一致：发现服务/特征后订阅通知即可，无需 GattSession 或配对
        result = await device.get_gatt_services_for_uuid_async(HR_SERVICE_UUID)
        status = getattr(result, "status", None)
        if status != 0:  # GattCommunicationStatus.Success
            _close_device(device)
            return {"ok": False, "error": "gatt access denied (status {}); make sure the band is idle (phone Bluetooth off)".format(status)}

        services = list(result.services) if getattr(result, "services", None) else []
        if not services:
            _close_device(device)
            return {"ok": False, "error": "heart rate service not found"}
        service = services[0]

        chars = await service.get_characteristics_for_uuid_async(HR_MEASUREMENT_UUID)
        char_list = list(chars.characteristics) if chars.characteristics else []
        if not char_list:
            _close_device(device)
            return {"ok": False, "error": "heart rate characteristic not found"}
        characteristic = char_list[0]

        def on_value_changed(sender, args):
            _on_value(args.characteristic_value)

        token = characteristic.add_value_changed(on_value_changed)
        cstatus = await characteristic.write_client_characteristic_configuration_descriptor_async(Ccd.NOTIFY)
        logger.info("HR CCD write status: {}", cstatus)
        if cstatus != 0:  # 0 == GattCommunicationStatus.Success
            _close_device(device)
            return {"ok": False, "error": "notification not supported (status {})".format(cstatus)}

        with _lock:
            _device = device
            _service = service
            _characteristic = characteristic
            _notify_token = token
            _state["connected"] = True
            _state["device_name"] = _clean_name(getattr(device, "name", "") or "")
            _state["address"] = addr
            _last_update = time.time()
        logger.info("Heart rate device connected: {} ({})", _state["device_name"], hex(addr))
        return {"ok": True, "name": _state["device_name"], "address": addr}
    except Exception as e:
        logger.warning("Heart rate connect failed: {}", e)
        _close_device(device)
        _device = None
        _service = None
        _characteristic = None
        _notify_token = None
        return {"ok": False, "error": str(e)}


def disconnect():
    """断开当前连接。"""
    fut = _submit(_disconnect_async(), "disconnect")
    if fut is None:
        return {"ok": False}
    try:
        fut.result(timeout=10)
        return {"ok": True}
    except Exception as e:
        logger.warning("HR disconnect failed: {}", e)
        return {"ok": False, "error": str(e)}


async def _disconnect_async():
    global _device, _service, _characteristic, _notify_token
    char, token = _characteristic, _notify_token
    if char is not None and token is not None:
        try:
            char.remove_value_changed(token)
        except Exception:
            pass
    _characteristic = None
    _notify_token = None
    _close_device(_device)
    _device = None
    _service = None
    with _lock:
        _state["connected"] = False
        _state["bpm"] = None
        _state["device_name"] = ""
        _state["address"] = None
        _last_update = 0.0


def _close_device(device):
    if device is None:
        return
    try:
        device.close()
    except Exception:
        pass


def _on_value(buf):
    """解析心率测量特征值（0x2A37）：flags 首位决定 8 位/16 位心率。"""
    global _last_update
    try:
        from winrt.windows.storage.streams import DataReader
        reader = DataReader.from_buffer(buf)
        data = bytearray(buf.length)
        reader.read_bytes(data)
    except Exception as e:
        logger.debug("HR read bytes failed: {}", e)
        return
    if len(data) < 2:
        return
    flags = data[0]
    if flags & 0x01:
        if len(data) < 3:
            return
        bpm = data[1] | (data[2] << 8)
    else:
        bpm = data[1]
    if bpm <= 0:
        return
    with _lock:
        _state["bpm"] = bpm
        _last_update = time.time()


def get_current():
    """返回当前心率状态：{connected, bpm, device_name, address}。

    超过 STALE_SECONDS 未收到数据时视为断开，bpm 返回 None（前端显示 --）。
    """
    with _lock:
        if _state["connected"] and (_last_update == 0.0 or time.time() - _last_update > STALE_SECONDS):
            return {
                "connected": False,
                "bpm": None,
                "device_name": _state["device_name"],
                "address": _state["address"],
            }
        return dict(_state)
