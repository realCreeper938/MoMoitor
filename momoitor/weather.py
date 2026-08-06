"""QWeather（和风天气）API 客户端，使用 JWT 认证。

主要方法:
- get_now(lat, lon, key_id, project_id, private_key, proxies): 获取当前天气
- get_city_name(lat, lon, key_id, project_id, private_key, proxies): 获取城市名称
- get_minutely(lat, lon, key_id, project_id, private_key, proxies): 获取分钟级降水预报
- get_airquality(lat, lon, key_id, project_id, private_key, proxies): 获取空气质量
- get_alerts(lat, lon, key_id, project_id, private_key, proxies): 获取天气预警

主要变量:
- API_HOST: 和风天气API主机地址
- _city_cache: 城市名称缓存
- _city_cache_ts: 城市缓存时间戳
"""

import time
import jwt
import requests
from loguru import logger

API_HOST = "https://devapi.qweather.com"


def _build_jwt(key_id: str, project_id: str, private_key: str) -> str:
    now = int(time.time())
    payload = {"sub": project_id, "iat": now - 30, "exp": now + 900}
    headers = {"kid": key_id}
    return jwt.encode(payload, private_key, algorithm="EdDSA", headers=headers)


def _headers(key_id: str, project_id: str, private_key: str) -> dict:
    return {"Authorization": f"Bearer {_build_jwt(key_id, project_id, private_key)}"}


def get_now(lat: str, lon: str, key_id: str, project_id: str, private_key: str) -> dict:
    location = f"{lon},{lat}"
    resp = requests.get(
        f"{API_HOST}/v7/weather/now",
        params={"location": location},
        headers=_headers(key_id, project_id, private_key),
        timeout=5,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != "200":
        return {"error": data.get("code")}
    now = data["now"]
    city = get_city_name(lat, lon, key_id, project_id, private_key)
    return {
        "text": now["text"],
        "temp": now["temp"],
        "feelsLike": now["feelsLike"],
        "humidity": now["humidity"],
        "windDir": now["windDir"],
        "windScale": now["windScale"],
        "icon": now.get("icon", ""),
        "city": city,
        "updateTime": data.get("updateTime", ""),
    }


_city_cache = {}  # 键为 "lat,lon"，值为 {"name": str, "ts": float}

def get_city_name(lat: str, lon: str, key_id: str, project_id: str, private_key: str) -> str:
    cache_key = f"{lat},{lon}"
    now = time.time()
    cached = _city_cache.get(cache_key)
    if cached and now - cached.get("ts", 0) < 86400:
        return cached.get("name", "")
    try:
        resp = requests.get(
            "https://geoapi.qweather.com/v2/city/lookup",
            params={"location": f"{lon},{lat}", "number": 1},
            headers=_headers(key_id, project_id, private_key),
            timeout=5,
            )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") == "200" and data.get("location"):
            name = data["location"][0].get("name", "")
            _city_cache[cache_key] = {"name": name, "ts": now}
            return name
    except Exception:
        pass
    return cached.get("name", "") if cached else ""


def get_minutely(lat: str, lon: str, key_id: str, project_id: str, private_key: str) -> dict:
    location = f"{lon},{lat}"
    resp = requests.get(
        f"{API_HOST}/v7/minutely/5m",
        params={"location": location, "lang": "zh"},
        headers=_headers(key_id, project_id, private_key),
        timeout=5,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != "200":
        return {"error": data.get("code")}
    return {
        "summary": data.get("summary", ""),
        "minutely": [
            {"time": m.get("fxTime", ""), "precip": float(m.get("precip") or 0), "type": m.get("type", "")}
            for m in data.get("minutely", [])
        ],
    }


def get_airquality(lat: str, lon: str, key_id: str, project_id: str, private_key: str) -> dict:
    resp = requests.get(
        f"{API_HOST}/airquality/v1/current/{lat}/{lon}",
        params={"lang": "zh"},
        headers=_headers(key_id, project_id, private_key),
        timeout=5,
    )
    resp.raise_for_status()
    data = resp.json()
    indexes = []
    for idx in data.get("indexes") or []:
        color = idx.get("color") or {}
        pp = idx.get("primaryPollutant") or {}
        health = idx.get("health") or {}
        advice = health.get("advice") or {}
        indexes.append({
            "code": idx.get("code") or "",
            "name": idx.get("name") or "",
            "aqi": idx.get("aqi"),
            "aqiDisplay": idx.get("aqiDisplay") or "",
            "level": idx.get("level") or "",
            "category": idx.get("category") or "",
            "colorR": color.get("red") or 0,
            "colorG": color.get("green") or 0,
            "colorB": color.get("blue") or 0,
            "primary": pp.get("name") or "",
            "effect": health.get("effect") or "",
            "adviceGeneral": advice.get("generalPopulation") or "",
        })
    pollutants = []
    for p in data.get("pollutants") or []:
        conc = p.get("concentration") or {}
        pollutants.append({
            "name": p.get("name") or "",
            "value": conc.get("value"),
            "unit": conc.get("unit") or "",
        })
    return {"indexes": indexes, "pollutants": pollutants}


def get_alerts(lat: str, lon: str, key_id: str, project_id: str, private_key: str) -> list:
    resp = requests.get(
        f"{API_HOST}/weatheralert/v1/current/{lat}/{lon}",
        params={"localTime": "true", "lang": "zh"},
        headers=_headers(key_id, project_id, private_key),
        timeout=5,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("metadata", {}).get("zeroResult", True):
        return []
    result = []
    for a in data.get("alerts", []):
        color = a.get("color", {})
        result.append({
            "id": a.get("id"),
            "headline": a.get("headline", ""),
            "description": a.get("description", ""),
            "instruction": a.get("instruction", ""),
            "severity": a.get("severity", ""),
            "eventType": a.get("eventType", {}).get("name", ""),
            "colorCode": color.get("code", ""),
            "colorR": color.get("red", 0),
            "colorG": color.get("green", 0),
            "colorB": color.get("blue", 0),
            "publishTime": a.get("effectiveTime", ""),
            "expireTime": a.get("expireTime", ""),
        })
    return result

