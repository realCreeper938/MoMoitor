"""带缓存的天气服务 —— 委托给天气 API 客户端。

主要方法:
- WeatherService类: 线程安全的天气数据提供者
  - invalidate(): 清除所有缓存
  - get_now(): 获取当前天气
  - get_detail(): 获取详细天气（当前+分钟级降水）
  - get_airquality(): 获取空气质量
  - get_alerts(): 获取天气预警
  - get_lunar_time(timezone): 获取农历时间

主要变量:
- WeatherService._get_settings: 获取设置的函数
- WeatherService._lock: 线程锁
- WeatherService._cache: 天气数据缓存
- WeatherService._ts: 缓存时间戳
- WeatherService._alerts_cache: 预警缓存
- WeatherService._lunar_cache: 农历缓存
"""

import threading
import time

import requests
from loguru import logger

from momoitor.config import has_weather_creds
from momoitor.weather import get_now, get_alerts, get_minutely, get_airquality


class WeatherService:
    """按端点缓存的线程安全天气数据提供者。"""

    def __init__(self, get_settings_fn):
        self._get_settings = get_settings_fn
        self._lock = threading.Lock()
        self._cache = {}
        self._ts = {}
        self._lunar_cache = {}
        self._lunar_ts = 0
        self._lunar_tz = ""

    def invalidate(self):
        """清除所有缓存（设置变更后调用）。"""
        with self._lock:
            self._cache.clear()
            self._ts.clear()
            self._lunar_ts = 0

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
        with self._lock:
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
        s = self._get_settings()
        now = time.time()
        tz = timezone or "Asia/Shanghai"
        if now - self._lunar_ts < 3600 and self._lunar_cache and self._lunar_tz == tz:
            return self._lunar_cache
        try:
            resp = requests.get(
                "https://uapis.cn/api/v1/misc/lunartime",
                params={"ts": str(int(now)), "timezone": tz},
                timeout=5,
            )
            resp.raise_for_status()
            data = resp.json()
            self._lunar_cache = data
            self._lunar_ts = now
            self._lunar_tz = tz
            return data
        except Exception as e:
            logger.warning("Lunar time fetch failed: {}", e)
            return {"error": str(e)}

    # ── 内部 ─────────────────────────────────────────────────

    def _cached_call(self, key, ttl, fn, s):
        now = time.time()
        if now - self._ts.get(key, 0) < ttl and key in self._cache:
            return self._cache[key]
        try:
            result = fn(*self._wx_args(s))
            self._cache[key] = result
            self._ts[key] = now
            logger.info("Weather {} updated", key)
            return result
        except Exception as e:
            logger.error("Weather {} fetch failed: {}", key, e)
            return {"error": str(e)}
