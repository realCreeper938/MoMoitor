"""API 天气 mixin —— 天气、空气、预警的 JS 桥接方法。

WeatherMixin 转发到 momoitor.services.weather.WeatherService（惰性创建）。
"""


class WeatherMixin:
    """天气数据的 JS 桥接方法。"""

    def get_weather(self):
        return self.weather.get_now()

    def get_weather_detail(self):
        return self.weather.get_detail()

    def get_airquality(self):
        return self.weather.get_airquality()

    def get_alerts(self):
        return self.weather.get_alerts()
