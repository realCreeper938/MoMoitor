"""和风天气（QWeather）数据源 —— JWT 认证，全量能力。

能力：当前天气 / 城市名 / 分钟级降水 / 空气质量 / 天气预警。
"""

import time
from dataclasses import dataclass

import jwt
from loguru import logger

from momoitor.config import has_weather_creds
from momoitor.services.cache import TTLCache
from momoitor.services.weather import common

API_HOST = "https://devapi.qweather.com"

NAME = "qweather"
HAS_MINUTELY = True
HAS_AQI = True
HAS_ALERTS = True


@dataclass
class _Creds:
    """和风天气 API 凭证与位置参数。"""
    lat: str
    lon: str
    key_id: str
    project_id: str
    private_key: str

    def location(self):
        return f"{self.lon},{self.lat}"


def available(w: dict) -> bool:
    return has_weather_creds({"weather": w or {}})


def _creds(w: dict) -> _Creds:
    return _Creds(w.get("lat", ""), w.get("lon", ""),
                  w.get("key_id", ""), w.get("project_id", ""), w.get("private_key", ""))


def _build_jwt(key_id: str, project_id: str, private_key: str) -> str:
    now = int(time.time())
    payload = {"sub": project_id, "iat": now - 30, "exp": now + 900}
    headers = {"kid": key_id}
    return jwt.encode(payload, private_key, algorithm="EdDSA", headers=headers)


def _auth_headers(c: _Creds) -> dict:
    return {"Authorization": f"Bearer {_build_jwt(c.key_id, c.project_id, c.private_key)}"}


def category_from_icon(code) -> str:
    """和风图标码转归一化类别（与旧前端 wxCategory 规则一致）。"""
    c = str(code or "")
    if c in ("100", "150"):
        return "sun"
    if c in ("900", "901"):
        return "storm"
    if c.startswith("4"):
        return "snow"
    if c.startswith("3"):
        return "rain"
    if c.startswith("5"):
        return "fog"
    if c in ("104", "153"):
        return "overcast"
    return "cloud"


_city_cache = TTLCache()  # 键为 "lat,lon"，值为城市名


def get_city_name(c: _Creds) -> str:
    cache_key = f"{c.lat},{c.lon}"
    name, fresh = _city_cache.get(cache_key, 86400)
    if not fresh:
        try:
            data = common.get_json(
                "https://geoapi.qweather.com/v2/city/lookup",
                params={"location": c.location(), "number": 1},
                headers=_auth_headers(c),
            )
            if data.get("code") == "200" and data.get("location"):
                name = data["location"][0].get("name", "")
                _city_cache.set(cache_key, name)
        except Exception as e:
            logger.debug("QWeather city lookup failed: {}", e)
        if name is None:
            # 刷新失败时回退使用旧值（若有）
            name, _ = _city_cache.get(cache_key, None)
    return name or ""


def get_now(w: dict) -> dict:
    c = _creds(w)
    data = common.get_json(
        f"{API_HOST}/v7/weather/now",
        params={"location": c.location()},
        headers=_auth_headers(c),
    )
    if data.get("code") != "200":
        return {"error": data.get("code")}
    now = data["now"]
    city = get_city_name(c)
    return {
        "text": now["text"],
        "temp": now["temp"],
        "feelsLike": now["feelsLike"],
        "humidity": now["humidity"],
        "windDir": now["windDir"],
        "windScale": now["windScale"],
        "icon": category_from_icon(now.get("icon")),
        "city": city,
        "updateTime": data.get("updateTime", ""),
    }


def get_minutely(w: dict) -> dict:
    c = _creds(w)
    data = common.get_json(
        f"{API_HOST}/v7/minutely/5m",
        params={"location": c.location(), "lang": "zh"},
        headers=_auth_headers(c),
    )
    if data.get("code") != "200":
        return {"error": data.get("code")}
    return {
        "summary": data.get("summary", ""),
        "minutely": [
            {"time": m.get("fxTime", ""), "precip": float(m.get("precip") or 0), "type": m.get("type", "")}
            for m in data.get("minutely", [])
        ],
    }


def get_airquality(w: dict) -> dict:
    c = _creds(w)
    data = common.get_json(
        f"{API_HOST}/airquality/v1/current/{c.lat}/{c.lon}",
        params={"lang": "zh"},
        headers=_auth_headers(c),
    )
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


def get_alerts(w: dict) -> list:
    c = _creds(w)
    data = common.get_json(
        f"{API_HOST}/weatheralert/v1/current/{c.lat}/{c.lon}",
        params={"localTime": "true", "lang": "zh"},
        headers=_auth_headers(c),
    )
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
            "initialPublishTime": a.get("issuedTime", ""),
            "messageTypeCode": a.get("messageType", {}).get("code", ""),
            "expireTime": a.get("expireTime", ""),
        })
    return result
