"""日历服务 —— 显示/隐藏日历覆盖层、获取黄历。

主要方法:
- get_huangli(year, month, day): 获取农历黄历信息
- show_calendar(window): 显示日历覆盖层
- hide_calendar(window): 隐藏日历覆盖层
"""

from loguru import logger


def _eval_js(window, js_expr: str) -> bool:
    if not window:
        return False
    try:
        window.evaluate_js(js_expr)
        return True
    except Exception as e:
        logger.warning("evaluate_js failed: {}", e)
        return False


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



