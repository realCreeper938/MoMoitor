"""pywebview API 桥接层 —— 由四个能力 mixin 组合成对外 Api。

- api.core.ApiCore: 状态 / 生命周期 / 设置 / 自启动 / 窗口控制
- api.hardware.HardwareMixin: 硬件数据 / 系统信息 / 进程 / 端口
- api.weather.WeatherMixin: 天气 / 黄历 / 节假日
- api.media.MediaMixin: 音乐 / 歌词 / FPS / 流量 / 壁纸 / 音量亮度

用法（对外唯一入口，保持向后兼容）:
    from momoitor.api import create_monitor, create_window, create_api
"""

import os

import webview

from momoitor.config import WEB_DIR, load_settings
from momoitor.services import window as win_svc

from .core import ApiCore
from .hardware import HardwareMixin
from .media import MediaMixin
from .weather import WeatherMixin

__all__ = ["Api", "create_monitor", "create_window", "create_api"]


class Api(ApiCore, HardwareMixin, WeatherMixin, MediaMixin):
    """面向前端 JS 的 pywebview API 门面（组合各能力 mixin）。"""


def create_monitor():
    settings = load_settings()
    source = settings.get("general", {}).get("data_source", "lhm")
    from momoitor.backends import LHMMonitor, HWiNFOMonitor
    if source == "hwinfo":
        return HWiNFOMonitor()
    return LHMMonitor()


def create_window(monitor):
    api = Api(monitor)
    index = os.path.join(WEB_DIR, "index.html")

    mon_idx = api._settings.get("display", {}).get("monitor", 0)
    monitors = win_svc.get_monitors()
    wx = wy = None
    ww, wh = 800, 600
    if 0 <= mon_idx < len(monitors):
        m = monitors[mon_idx]
        wx, wy, ww, wh = m["x"], m["y"], m["width"], m["height"]

    window = webview.create_window(
        "MoMoitor", url=index, js_api=api,
        fullscreen=False, frameless=False, easy_drag=False,
        background_color="#050505", on_top=True,
        x=wx, y=wy, width=ww, height=wh,
    )
    api.set_window(window)
    from momoitor.services import fps as _fps
    from momoitor.services import music as _music
    _fps.start()
    _music.start()
    return window, api


def create_api(monitor):
    """服务端模式：仅创建 Api 实例，不创建 webview 窗口。"""
    api = Api(monitor)
    from momoitor.services import fps as _fps
    from momoitor.services import music as _music
    _fps.start()
    _music.start()
    return api