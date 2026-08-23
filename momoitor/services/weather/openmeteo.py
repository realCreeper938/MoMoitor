"""Open-Meteo 数据源 —— 免密钥，免费公开 API。

能力：当前天气（WMO 天气码）/ 空气质量（US AQI）。
不支持：天气预警；无逆地理编码，城市名不提供。
"""

import requests

from momoitor.services.weather import common

_FORECAST = "https://api.open-meteo.com/v1/forecast"
_AIR = "https://air-quality-api.open-meteo.com/v1/air-quality"

NAME = "open-meteo"
HAS_MINUTELY = False
HAS_AQI = True
HAS_ALERTS = False

# WMO 天气码 → (归一化类别, 中文描述)
_WMO = {
    0: ("sun", "晴"),
    1: ("sun", "大致晴朗"),
    2: ("cloud", "多云"),
    3: ("overcast", "阴"),
    45: ("fog", "雾"),
    48: ("fog", "雾凇"),
    51: ("rain", "小毛毛雨"),
    53: ("rain", "毛毛雨"),
    55: ("rain", "浓毛毛雨"),
    56: ("rain", "冻毛毛雨"),
    57: ("rain", "强冻毛毛雨"),
    61: ("rain", "小雨"),
    63: ("rain", "中雨"),
    65: ("rain", "大雨"),
    66: ("rain", "冻雨"),
    67: ("rain", "强冻雨"),
    71: ("snow", "小雪"),
    73: ("snow", "中雪"),
    75: ("snow", "大雪"),
    77: ("snow", "雪粒"),
    80: ("rain", "小阵雨"),
    81: ("rain", "阵雨"),
    82: ("rain", "强阵雨"),
    85: ("snow", "小阵雪"),
    86: ("snow", "阵雪"),
    95: ("storm", "雷阵雨"),
    96: ("storm", "雷阵雨伴冰雹"),
    99: ("storm", "强雷阵雨伴冰雹"),
}

# 污染物字段名 → 展示名
_POLLUTANT_NAMES = {"pm2_5": "PM2.5", "pm10": "PM10"}


def available(w: dict) -> bool:
    w = w or {}
    return bool(w.get("lat") and w.get("lon"))


def get_now(w: dict) -> dict:
    resp = requests.get(
        _FORECAST,
        params={
            "latitude": w.get("lat"), "longitude": w.get("lon"),
            "current": ("temperature_2m,relative_humidity_2m,apparent_temperature,"
                        "weather_code,wind_speed_10m,wind_direction_10m"),
            "timezone": "auto",
        },
        timeout=5,
    )
    resp.raise_for_status()
    data = resp.json()
    cur = data.get("current") or {}
    code = cur.get("weather_code")
    category, text = _WMO.get(code, ("cloud", ""))
    deg = cur.get("wind_direction_10m")
    speed_kmh = cur.get("wind_speed_10m")
    speed_ms = None if speed_kmh is None else float(speed_kmh) / 3.6
    now = {
        "text": text,
        "temp": cur.get("temperature_2m"),
        "feelsLike": cur.get("apparent_temperature"),
        "humidity": cur.get("relative_humidity_2m"),
        "icon": category,
        # 本地时间字符串（如 2026-08-23T17:30），JS Date 按本地时区解析
        "updateTime": cur.get("time") or "",
    }
    if deg is not None:
        now["windDir"] = common.wind_dir_zh(deg)
    scale = common.beaufort(speed_ms)
    if scale is not None:
        now["windScale"] = scale
    return now


def get_airquality(w: dict) -> dict:
    resp = requests.get(
        _AIR,
        params={
            "latitude": w.get("lat"), "longitude": w.get("lon"),
            "current": "us_aqi,pm2_5,pm10",
            "timezone": "auto",
        },
        timeout=5,
    )
    resp.raise_for_status()
    data = resp.json()
    cur = data.get("current") or {}
    aqi = cur.get("us_aqi")
    indexes = []
    if aqi is not None:
        indexes.append({
            "code": "us",
            "name": "US AQI",
            "aqi": int(aqi),
            "aqiDisplay": str(int(aqi)),
            "level": "",
            "category": common.us_aqi_category(int(aqi)),
            "colorR": 0,
            "colorG": 0,
            "colorB": 0,
            "primary": "",
            "effect": "",
            "adviceGeneral": "",
        })
    pollutants = []
    for key, name in _POLLUTANT_NAMES.items():
        value = cur.get(key)
        if value is not None:
            pollutants.append({"name": name, "value": value, "unit": "μg/m³"})
    return {"indexes": indexes, "pollutants": pollutants}
