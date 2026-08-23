"""天气数据源共享工具：罗盘方位、蒲福风级、AQI 分级、时间格式。

各数据源模块把自家响应归一化为统一内部结构（见各 get_now 返回），
字段缺失时直接省略键或置 None，由前端隐藏对应元素。
"""

from datetime import datetime, timezone

# 归一化天气类别（前端 data-wx / 图标均按此取值）
CATEGORIES = ("sun", "cloud", "overcast", "rain", "snow", "fog", "storm")

# 蒲福风级下界（m/s）：低于首界为 0 级，依次递增，最高 12 级
_BEAUFORT_BOUNDS = (0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7)

_COMPASS_8 = ("北", "东北", "东", "东南", "南", "西南", "西", "西北")


def beaufort(speed_ms) -> int | None:
    """风速（m/s）转蒲福风级；无法解析时返回 None。"""
    try:
        v = float(speed_ms)
    except (TypeError, ValueError):
        return None
    for level, bound in enumerate(_BEAUFORT_BOUNDS):
        if v < bound:
            return level
    return len(_BEAUFORT_BOUNDS)


def wind_dir_zh(deg) -> str:
    """风向角度转八方位中文名；无法解析时返回空串。"""
    try:
        d = float(deg)
    except (TypeError, ValueError):
        return ""
    idx = int(((d % 360) + 22.5) // 45) % 8
    return _COMPASS_8[idx]


def us_aqi_category(aqi: int) -> str:
    """US AQI 数值转中文分级（与前端 aqiColorClass 的关键词匹配）。"""
    if aqi <= 50:
        return "优"
    if aqi <= 100:
        return "良"
    if aqi <= 150:
        return "轻度污染"
    if aqi <= 200:
        return "中度污染"
    if aqi <= 300:
        return "重度污染"
    return "严重污染"


def iso_utc(ts_seconds) -> str:
    """Unix 时间戳转 ISO 字符串（UTC，带偏移量，JS Date 可直接解析）。"""
    try:
        return datetime.fromtimestamp(int(ts_seconds), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return ""
