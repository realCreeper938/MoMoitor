"""电池服务 —— 电量、充电状态与功率。

电量/是否接电用 psutil.sensors_battery()；功率（mW）来自 WMI
root\\wmi 的 BatteryStatus 类：充电时用 ChargeRate，放电时用
DischargeRate。WMI 不可用时功率返回 None。
"""

from loguru import logger

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None


def _battery_rate():
    """读取 WMI BatteryStatus 的充/放电速率（mW），失败返回 None。"""
    try:
        import clr
        clr.AddReference("System.Management")
        from System.Management import ManagementObjectSearcher, ManagementScope, ObjectQuery
        scope = ManagementScope("root\\wmi")
        searcher = ManagementObjectSearcher(scope, ObjectQuery(
            "SELECT ChargeRate, DischargeRate, PowerOnline FROM BatteryStatus"))
        for mo in searcher.Get():
            charge = _as_number(mo["ChargeRate"])
            discharge = _as_number(mo["DischargeRate"])
            if charge or discharge:
                return charge, discharge
        return None
    except Exception as e:
        logger.debug("battery WMI query failed: {}", e)
        return None


def _as_number(v):
    """把 WMI 返回的数值安全转为 int（非数字返回 0）。"""
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


def get_battery():
    """返回电池状态 dict。

    - percent: 剩余电量百分比（0-100），不可用为 None
    - charging: 是否正在充电
    - plugged: 是否接上电源
    - rate_w: 功率（瓦，正为充电、负为放电），不可用为 None
    - status: 状态文案（ac / discharging / charging / unknown）
    """
    info = {"percent": None, "charging": False, "plugged": False,
            "rate_w": None, "status": "unknown"}
    if psutil is not None:
        try:
            batt = psutil.sensors_battery()
            if batt is not None:
                info["percent"] = round(batt.percent)
                info["plugged"] = bool(batt.power_plugged)
        except Exception as e:
            logger.debug("psutil battery failed: {}", e)

    rate = _battery_rate()
    if rate is not None:
        charge, discharge = rate
        if charge > 0:
            info["rate_w"] = round(charge / 1000.0, 2)
        elif discharge > 0:
            info["rate_w"] = round(-discharge / 1000.0, 2)

    if info["plugged"]:
        info["status"] = "charging" if (info["rate_w"] or 0) > 0 else "ac"
        info["charging"] = info["status"] == "charging"
    elif info["percent"] is not None:
        info["status"] = "discharging"
    return info
