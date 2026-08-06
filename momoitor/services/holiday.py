"""节假日 / 调休补班服务。

主要方法:
- HolidayService类: 中国法定节假日与调休补班信息提供者
  - get_year(year): 获取某年的节假日数据（含调休）
  - invalidate(): 清除缓存

数据来源: https://timor.tech/api/holiday (无需密钥)
返回结构: {"MM-DD": {"holiday": bool, "name": str, "date": str, ...}}
  - holiday == true  : 休息日（放假），name 为节日名
  - holiday == false : 调休补班（工作日上班），如周末调休
"""

import threading
import time

import requests
from loguru import logger

HOLIDAY_API = "https://timor.tech/api/holiday/year/{year}"
CACHE_TTL = 86400
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


class HolidayService:
    """带按年缓存的线程安全节假日数据提供者。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._cache = {}  # 年份 -> {"data": dict, "ts": float}

    def invalidate(self):
        with self._lock:
            self._cache.clear()

    def _fetch(self, year):
        resp = requests.get(HOLIDAY_API.format(year=year), headers={"User-Agent": UA}, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            logger.warning("Holiday API returned code {} for {}", data.get("code"), year)
            return {}
        return data.get("holiday") or {}

    def get_year(self, year):
        try:
            year = int(year)
        except (TypeError, ValueError):
            return {}
        with self._lock:
            cached = self._cache.get(year)
            if cached and time.time() - cached["ts"] < CACHE_TTL:
                return cached["data"]
        try:
            data = self._fetch(year)
        except Exception as e:
            logger.warning("Holiday fetch failed for {}: {}", year, e)
            with self._lock:
                cached = self._cache.get(year)
                if cached:
                    return cached["data"]
            return {}
        with self._lock:
            self._cache[year] = {"data": data, "ts": time.time()}
        return data
