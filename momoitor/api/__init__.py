"""pywebview API 桥接层 —— 由多个能力 mixin 组合成对外 Api。

- api.core.ApiCore: 状态 / 生命周期 / 设置 / 自启动 / 窗口控制
- api.hardware.HardwareMixin: 硬件数据 / 系统信息 / 进程 / 端口
- api.weather.WeatherMixin: 天气 / 黄历 / 节假日
- api.media.MediaMixin: 音乐 / 歌词 / FPS / 流量 / 壁纸 / 音量亮度
- api.backup.BackupMixin: 数据备份 / 还原
- api.hr.HrMixin: 心率（BLE）

用法（对外唯一入口，保持向后兼容）:
    from momoitor.api import create_monitor, create_window, create_api
"""

import os

import webview

from momoitor.config import WEB_DIR, load_settings
from momoitor.services import window as win_svc

from .backup import BackupMixin
from .core import ApiCore
from .hardware import HardwareMixin
from .hr import HrMixin
from .media import MediaMixin
from .weather import WeatherMixin

__all__ = ["Api", "create_monitor", "create_window", "create_api"]


class Api(ApiCore, HardwareMixin, WeatherMixin, MediaMixin, HrMixin, BackupMixin):
    """面向前端 JS 的 pywebview API 门面（组合各能力 mixin）。"""


def create_monitor():
    settings = load_settings()
    from momoitor.services.hardware import _sources_from_settings, build_monitor
    return build_monitor(_sources_from_settings(settings))


def _start_background_services(api):
    """按 feature_toggles 启动后台服务，避免未启用的功能每秒空转。

    fps / music 受对应功能开关控制；hr 仅创建事件循环线程（近乎零开销），
    设备连接由前端根据心率卡片是否可见通过 connect_hr / disconnect_hr 驱动，
    未添加心率卡片时不会产生任何数据获取。
    """
    from momoitor.services import fps as _fps
    from momoitor.services import hr as _hr
    from momoitor.services import music as _music
    if api._feature_on("fps"):
        _fps.start()
    _hr.start()
    if api._feature_on("music"):
        _music.start()
    api._sync_spectrum()


def _target_screen(display: dict, screens: list):
    """根据 display 设置解析目标 webview.Screen，无偏好/缺失时回退到首屏/主屏。

    webview.Screen 只暴露坐标/尺寸/缩放，不含设备 ID。因此统一先经 win_svc 的
    物理枚举（含设备 ID）解析出目标屏，再按其下标从 webview.screens 取同序 Screen。
    """
    if not screens:
        return None
    mon_target = win_svc.display_target(display)
    monitors = win_svc.get_monitors()
    target_monitor, _ = win_svc.find_display(mon_target, monitors)
    if target_monitor is None:
        return screens[0]
    try:
        idx = monitors.index(target_monitor)
    except ValueError:
        idx = 0
    return screens[idx] if 0 <= idx < len(screens) else screens[0]


def create_window(monitor):
    api = Api(monitor)
    index = os.path.join(WEB_DIR, "index.html")

    on_top = api._settings.get("display", {}).get("on_top", True)
    screens = webview.screens
    ww, wh = 800, 600
    target_screen = _target_screen(api._settings.get("display", {}), screens)
    if target_screen is not None:
        ww, wh = target_screen.width, target_screen.height

    window = webview.create_window(
        "MoMoitor", url=index, js_api=api,
        fullscreen=False, frameless=False, easy_drag=False,
        background_color="#050505", on_top=on_top,
        width=ww, height=wh, screen=target_screen,
    )
    api.set_window(window)
    _start_background_services(api)
    return window, api


def create_api(monitor):
    """服务端模式：仅创建 Api 实例，不创建 webview 窗口。"""
    api = Api(monitor)
    _start_background_services(api)
    return api