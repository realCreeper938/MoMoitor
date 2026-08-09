"""API 天气/日历 mixin —— 天气、空气、预警、农历、节假日。

WeatherMixin 转发到 momoitor.services.weather.WeatherService（惰性创建）、
momoitor.services.calendar 与 HolidayService，并统一做 feature_toggles 开关判断。
"""

from momoitor.services.calendar import get_huangli


class WeatherMixin:
    """天气、黄历、节假日的 JS 桥接方法。"""

    def get_weather(self):
        return self._weather.get_now()

    def get_weather_detail(self):
        return self._weather.get_detail()

    def get_airquality(self):
        return self._weather.get_airquality()

    def get_weather_info(self):
        weather = self._weather.get_now()
        air = self._weather.get_airquality()
        return {"weather": weather, "air_quality": air}

    def get_alerts(self):
        return self._weather.get_alerts()

    def get_lunar_time(self, timezone="Asia/Shanghai"):
        if not self._feature_on("weather"):
            return {"error": "disabled"}
        return self._weather.get_lunar_time(timezone)

    def get_huangli(self, year=None, month=None, day=None):
        if not self._feature_on("calendar"):
            return {"error": "disabled"}
        return get_huangli(year, month, day)

    def get_holiday(self, year):
        if not self._feature_on("calendar"):
            return {}
        return self._holiday.get_year(year)