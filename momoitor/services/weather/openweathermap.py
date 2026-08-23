"""OpenWeatherMap 数据源 —— AppID 认证，免费端点。

能力：当前天气（自带城市名）/ 空气污染（1-5 级 AQI）。
不支持：分钟级降水、天气预警（One Call 3.0 需单独订阅，暂不接入）。
"""

import requests

from momoitor.services.weather import common

_BASE = "https://api.openweathermap.org/data/2.5"

NAME = "openweathermap"
HAS_MINUTELY = False
HAS_AQI = True
HAS_ALERTS = False

# OWM weather.main → 归一化类别
_MAIN_CATEGORY = {
    "Clear": "sun",
    "Clouds": "cloud",
    "Rain": "rain",
    "Drizzle": "rain",
    "Thunderstorm": "storm",
    "Snow": "snow",
    "Mist": "fog",
    "Fog": "fog",
    "Haze": "fog",
    "Dust": "fog",
    "Sand": "fog",
    "Ash": "fog",
    "Squall": "storm",
    "Tornado": "storm",
}

# OWM 空气污染 1-5 级 → 中文分级
_AQI_CATEGORY = {1: "优", 2: "良", 3: "轻度污染", 4: "中度污染", 5: "重度污染"}


def available(w: dict) -> bool:
    w = w or {}
    return bool(w.get("appid") and w.get("lat") and w.get("lon"))


def get_now(w: dict) -> dict:
    resp = requests.get(
        f"{_BASE}/weather",
        params={"lat": w.get("lat"), "lon": w.get("lon"),
                "units": "metric", "lang": "zh_cn", "appid": w.get("appid")},
        timeout=5,
    )
    resp.raise_for_status()
    data = resp.json()
    main = data.get("main") or {}
    weather = (data.get("weather") or [{}])[0]
    wind = data.get("wind") or {}
    deg = wind.get("deg")
    speed = wind.get("speed")
    return {
        "text": weather.get("description") or "",
        "temp": main.get("temp"),
        "feelsLike": main.get("feels_like"),
        "humidity": main.get("humidity"),
        "windDir": common.wind_dir_zh(deg) if deg is not None else "",
        "windScale": common.beaufort(speed),
        "icon": _MAIN_CATEGORY.get(weather.get("main"), "cloud"),
        "city": data.get("name") or "",
        "updateTime": common.iso_utc(data.get("dt")),
    }


def get_airquality(w: dict) -> dict:
    resp = requests.get(
        f"{_BASE}/air_pollution",
        params={"lat": w.get("lat"), "lon": w.get("lon"), "appid": w.get("appid")},
        timeout=5,
    )
    resp.raise_for_status()
    data = resp.json()
    entries = data.get("list") or []
    if not entries:
        return {"indexes": [], "pollutants": []}
    entry = entries[0]
    aqi = (entry.get("main") or {}).get("aqi")
    if aqi is None:
        return {"indexes": [], "pollutants": []}
    indexes = [{
        "code": "owm",
        "name": "OpenWeatherMap AQI",
        "aqi": aqi,
        "aqiDisplay": str(aqi),
        "level": "",
        "category": _AQI_CATEGORY.get(aqi, ""),
        "colorR": 0,
        "colorG": 0,
        "colorB": 0,
        "primary": "",
        "effect": "",
        "adviceGeneral": "",
    }]
    pollutants = [
        {"name": name, "value": value, "unit": "μg/m³"}
        for name, value in (entry.get("components") or {}).items()
    ]
    return {"indexes": indexes, "pollutants": pollutants}
