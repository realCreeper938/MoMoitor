"""天气服务 —— 多数据源天气客户端 + 带缓存的 WeatherService。

支持数据源（settings.weather.source）:
- qweather        和风天气（JWT 认证；当前天气/分钟降水/空气质量/预警）
- openweathermap  OpenWeatherMap（AppID；当前天气/空气质量）
- open-meteo      Open-Meteo（免密钥；当前天气/空气质量）

各数据源模块把响应归一化为统一结构；数据源不支持的能力直接跳过请求、
不下发数据，由前端隐藏对应元素。缓存键包含数据源名，切换后互不污染。

WeatherService 公开接口（供 api 层调用）:
- invalidate(): 清除所有缓存
- get_now(): 获取当前天气
- get_detail(): 获取详细天气（当前+分钟级降水）
- get_airquality(): 获取空气质量
- get_alerts(): 获取天气预警
- get_lunar_time(timezone): 获取农历时间（与数据源无关）
"""

import time

from loguru import logger

from momoitor.common import http_get
from momoitor.services.cache import TTLCache
from momoitor.services.weather import openmeteo, openweathermap, qweather

_PROVIDERS = {
    qweather.NAME: qweather,
    openweathermap.NAME: openweathermap,
    openmeteo.NAME: openmeteo,
}

_EMPTY_MINUTELY = {"summary": "", "minutely": []}
_EMPTY_AIR = {"indexes": [], "pollutants": []}


class WeatherService:
    """按端点缓存、按数据源分发的线程安全天气数据提供者。"""

    def __init__(self, get_settings_fn):
        self._get_settings = get_settings_fn
        self._cache = TTLCache()

    def invalidate(self):
        """清除所有缓存（设置变更后调用）。"""
        self._cache.clear()

    def _weather_settings(self) -> dict:
        return self._get_settings().get("weather", {}) or {}

    def _disabled(self):
        """天气开关 weather.enabled 关闭时不获取任何天气信息。"""
        return not self._weather_settings().get("enabled", True)

    def _resolve(self):
        """返回 (provider 模块, weather 设置字典)；未配置凭证时返回 (None, w)。"""
        w = self._weather_settings()
        provider = _PROVIDERS.get(w.get("source") or qweather.NAME, qweather)
        if not provider.available(w):
            return None, w
        return provider, w

    def get_now(self):
        if self._disabled():
            return {"error": "disabled"}
        provider, w = self._resolve()
        if not provider:
            return {"error": "not_configured"}
        return self._cached_call(provider, "now", 600, provider.get_now, w)

    def get_detail(self):
        if self._disabled():
            return {"error": "disabled"}
        now_data = self.get_now()
        if "error" in now_data:
            return now_data
        detail = {"now": now_data}
        provider, w = self._resolve()
        if not provider or not provider.HAS_MINUTELY:
            detail["minutely"] = dict(_EMPTY_MINUTELY)
            return detail
        try:
            minutely_data = self._cached_call(provider, "minutely", 600, provider.get_minutely, w)
            if isinstance(minutely_data, dict) and "error" in minutely_data:
                minutely_data = dict(_EMPTY_MINUTELY)
            detail["minutely"] = minutely_data
        except Exception as e:
            logger.warning("Minutely fetch failed: {}", e)
            detail["minutely"] = dict(_EMPTY_MINUTELY)
        return detail

    def get_airquality(self):
        if self._disabled():
            return {"error": "disabled"}
        provider, w = self._resolve()
        if not provider or not provider.HAS_AQI:
            return dict(_EMPTY_AIR)
        result = self._cached_call(provider, "airquality", 600, provider.get_airquality, w)
        if isinstance(result, dict) and "error" in result:
            return dict(_EMPTY_AIR)
        return result

    def get_alerts(self):
        if self._disabled():
            return []
        provider, w = self._resolve()
        if not provider or not provider.HAS_ALERTS:
            return []
        result = self._cached_call(provider, "alerts", 600, provider.get_alerts, w)
        # _cached_call 失败时返回 {"error": ...}；get_alerts 应返回 []
        if isinstance(result, dict) and "error" in result:
            return []
        if result:
            logger.info("Alerts updated: {} alert(s)", len(result))
        return list(result)

    def get_lunar_time(self, timezone="Asia/Shanghai"):
        tz = timezone or "Asia/Shanghai"
        key = ("lunar", tz)
        cached, hit = self._cache.get(key, 3600)
        if hit:
            return cached
        try:
            resp = http_get(
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

    def _cached_call(self, provider, key, ttl, fn, w):
        value, hit = self._cache.get((provider.NAME, key), ttl)
        if hit:
            return value
        try:
            result = fn(w)
            self._cache.set((provider.NAME, key), result)
            logger.info("Weather {}:{} updated", provider.NAME, key)
            return result
        except Exception as e:
            logger.error("Weather {}:{} fetch failed: {}", provider.NAME, key, e)
            return {"error": str(e)}
