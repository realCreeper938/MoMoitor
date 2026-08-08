"""日历服务 —— 显示/隐藏日历覆盖层、获取黄历、节假日数据。

主要方法:
- get_huangli(year, month, day): 获取农历黄历信息
- show_calendar(window): 显示日历覆盖层
- hide_calendar(window): 隐藏日历覆盖层
- HolidayService: 中国法定节假日与调休补班信息提供者
  - get_year(year): 获取某年的节假日数据（含调休）
  - invalidate(): 清除缓存

节假日数据来源: https://timor.tech/api/holiday (无需密钥)
返回结构: {"MM-DD": {"holiday": bool, "name": str, "date": str, ...}}
  - holiday == true  : 休息日（放假），name 为节日名
  - holiday == false : 调休补班（工作日上班），如周末调休
"""

from loguru import logger

from momoitor.common import http_get
from momoitor.services.cache import TTLCache

# ── 黄历 / 日历覆盖层 ─────────────────────────────────────


def get_huangli(year=None, month=None, day=None) -> dict:
    try:
        import cnlunar
        from datetime import datetime
        dt = datetime(year, month, day) if (year and month and day) else datetime.now()
        a = cnlunar.Lunar(dt)
        goodThing = ' '.join(a.goodThing) if isinstance(a.goodThing, list) else a.goodThing
        badThing = ' '.join(a.badThing) if isinstance(a.badThing, list) else a.badThing
        return {
            "lunarYear": a.lunarYearCn, "lunarMonth": a.lunarMonthCn, "lunarDay": a.lunarDayCn,
            "year8Char": a.year8Char, "month8Char": a.month8Char, "day8Char": a.day8Char,
            "goodGod": a.goodGodName, "badGod": a.badGodName,
            "goodThing": goodThing, "badThing": badThing,
            "weekDay": a.weekDayCn, "zodiac": a.chineseYearZodiac,
            "jieqi": a.todaySolarTerms if hasattr(a, 'todaySolarTerms') else "",
        }
    except Exception as e:
        logger.error("Huangli fetch failed: {}", e)
        return {"error": str(e)}


def show_calendar(window) -> bool:
    return _eval_js(window, "window.showCalendar && window.showCalendar()")


def hide_calendar(window) -> bool:
    return _eval_js(window, "window.hideCalendar && window.hideCalendar()")


def _eval_js(window, js_expr: str) -> bool:
    if not window:
        return False
    try:
        window.evaluate_js(js_expr)
        return True
    except Exception as e:
        logger.warning("evaluate_js failed: {}", e)
        return False


# ── 节假日 ─────────────────────────────────────────────────

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