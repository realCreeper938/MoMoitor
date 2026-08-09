"""天气服务 —— 天气（和风天气）API 客户端 + 带缓存的 WeatherService。

数据来源:
- QWeather（和风天气）JWT 认证 API（当前天气 / 分钟级降水 / 空气质量 / 预警）
- uapis.cn 农历时间接口

客户端方法:
- get_now(lat, lon, key_id, project_id, private_key): 获取当前天气
- get_city_name(lat, lon, key_id, project_id, private_key): 获取城市名称
- get_minutely(lat, lon, key_id, project_id, private_key): 获取分钟级降水预报
- get_airquality(lat, lon, key_id, project_id, private_key): 获取空气质量
- get_alerts(lat, lon, key_id, project_id, private_key): 获取天气预警

WeatherService 类: 线程安全的天气数据提供者
- invalidate(): 清除所有缓存
- get_now(): 获取当前天气
- get_detail(): 获取详细天气（当前+分钟级降水）
- get_airquality(): 获取空气质量
- get_alerts(): 获取天气预警
- get_lunar_time(timezone): 获取农历时间
"""

import time

import jwt
import requests
from loguru import logger

from momoitor.config import has_weather_creds
from momoitor.services.cache import TTLCache

# ── QWeather 客户端 ─────────────────────────────────────────

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
            "initialPublishTime": a.get("issuedTime", ""),
            "messageTypeCode": a.get("messageType", {}).get("code", ""),
            "expireTime": a.get("expireTime", ""),
        })
    return result


# ── WeatherService（按端点缓存）──────────────────────────────

class WeatherService:
    """按端点缓存的线程安全天气数据提供者。"""

    def __init__(self, get_settings_fn):
        self._get_settings = get_settings_fn
        self._cache = TTLCache()

    def invalidate(self):
        """清除所有缓存（设置变更后调用）。"""
        self._cache.clear()

    def _creds(self):
        s = self._get_settings()
        if not has_weather_creds(s):
            return None
        return s

    def _wx_args(self, s):
        return (s["weather_lat"], s["weather_lon"],
                s["weather_key_id"], s["weather_project_id"], s["weather_private_key"])

    # ── 当前天气 ─────────────────────────────────────────────

    def get_now(self):
        s = self._creds()
        if not s:
            return {"error": "not_configured"}
        return self._cached_call("now", 600, get_now, s)

    # ── 详情（当前 + 分钟级降水）─────────────────────────────

    def get_detail(self):
        s = self._creds()
        if not s:
            return {"error": "not_configured"}
        now_data = self.get_now()
        if "error" in now_data:
            return now_data
        minutely_data = {"summary": "", "minutely": []}
        try:
            minutely_data = get_minutely(*self._wx_args(s))
        except Exception as e:
            logger.warning("Minutely fetch failed: {}", e)
        return {"now": now_data, "minutely": minutely_data}

    # ── 空气质量 ─────────────────────────────────────────────

    def get_airquality(self):
        s = self._creds()
        if not s:
            return {"error": "not_configured"}
        return self._cached_call("airquality", 600, get_airquality, s)

    # ── 预警 ─────────────────────────────────────────────────

    def get_alerts(self):
        s = self._creds()
        if not s:
            return []
        result = self._cached_call("alerts", 600, get_alerts, s)
        # _cached_call 失败时返回 {"error": ...}；get_alerts 应返回 []
        if isinstance(result, dict) and "error" in result:
            return []
        if result:
            logger.info("Alerts updated: {} alert(s)", len(result))
        return result

    # ── 农历时间 ─────────────────────────────────────────────

    def get_lunar_time(self, timezone="Asia/Shanghai"):
        tz = timezone or "Asia/Shanghai"
        key = ("lunar", tz)
        cached, hit = self._cache.get(key, 3600)
        if hit:
            return cached
        try:
            resp = requests.get(
                "https://uapis.cn/api/v1/misc/lunartime",
                params={"ts": str(int(time.time())), "timezone": tz},
                timeout=5,
            )
            resp.raise_for_status()
            data = resp.json()
            self._cache.set(key, data)
            return data
        except Exception as e:
            logger.warning("Lunar time fetch failed: {}", e)
            return {"error": str(e)}

    # ── 内部 ─────────────────────────────────────────────────

    def _cached_call(self, key, ttl, fn, s):
        value, hit = self._cache.get(key, ttl)
        if hit:
            return value
        try:
            result = fn(*self._wx_args(s))
            self._cache.set(key, result)
            logger.info("Weather {} updated", key)
            return result
        except Exception as e:
            logger.error("Weather {} fetch failed: {}", key, e)
            return {"error": str(e)}