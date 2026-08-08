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

from loguru import logger

from momoitor.common import http_get
from momoitor.services.cache import TTLCache

HOLIDAY_API = "https://timor.tech/api/holiday/year/{year}"
CACHE_TTL = 86400


class HolidayService:
    """带按年缓存的线程安全节假日数据提供者。"""

    def __init__(self):
        self._cache = TTLCache()

    def invalidate(self):
        self._cache.clear()

    def _fetch(self, year):
        resp = http_get(HOLIDAY_API.format(year=year), timeout=10)
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
        data, hit = self._cache.get(year, CACHE_TTL)
        if hit:
            return data
        try:
            data = self._fetch(year)
        except Exception as e:
            logger.warning("Holiday fetch failed for {}: {}", year, e)
            # 过期缓存兜底
            stale, hit = self._cache.get(year, None)
            return stale if hit else {}
        self._cache.set(year, data)
        return data