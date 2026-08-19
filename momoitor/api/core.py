"""API 核心 mixin —— 状态、生命周期、设置、窗口控制。

ApiCore 提供 Api.__init__ 需要的全部内部状态（_window / _settings / _hw 等）、
按需惰性创建的服务、通用开关判断，以及设置 / 自启动 / 关于 / 窗口 / 生命周期
等不直接属于硬件或媒体卡片的能力。由 api/__init__.py 的 Api 组合使用。
"""

import ctypes

from loguru import logger

from momoitor.config import (APP_AUTHOR, APP_GITHUB_REPO, APP_HOMEPAGE, APP_VERSION,
                             SETTINGS_FILE, load_settings, save_settings)
from momoitor.services import autostart, window as win_svc
from momoitor.services.system import get_run_identity
from momoitor.services.calendar import HolidayService
from momoitor.services.hardware import HardwareService
from momoitor.services.lyrics import LyricsService
from momoitor.services.traffic import TrafficService
from momoitor.services.update import check_latest as check_latest_release
from momoitor.services.weather import WeatherService


class ApiCore:
    """Api 的核心能力：状态、惰性服务、设置、自启动、窗口与生命周期。"""

    def __init__(self, monitor):
        self._window = None
        self._server_backend = None
        self._settings = load_settings()
        self._hw = HardwareService(monitor, self._settings)
        self._fullscreen = False
        self._weather = None
        self._holiday = None
        self._traffic = None
        self._lyrics = None
        logger.info("API initialized")

    @property
    def weather(self):
        if self._weather is None:
            self._weather = WeatherService(lambda: self._settings)
        return self._weather

    @property
    def holiday(self):
        if self._holiday is None:
            self._holiday = HolidayService()
        return self._holiday

    @property
    def traffic(self):
        if self._traffic is None:
            self._traffic = TrafficService()
        return self._traffic

    @property
    def lyrics(self):
        if self._lyrics is None:
            self._lyrics = LyricsService(lambda: self._settings)
        return self._lyrics

    def set_window(self, window):
        self._window = window
        self._remove_window_shadow()
        win_svc.set_opacity(window, self._settings.get("general", {}).get("window_opacity", 100))
        self.traffic.start()

    def set_server_backend(self, backend):
        """服务端模式：注入 HTTP 后端用于关闭等操作。"""
        self._server_backend = backend

    def js_log(self, level, message):
        log_func = getattr(logger, level, logger.debug)
        log_func("[JS] {}", message)

    def _feature_on(self, name):
        """对应功能开关是否开启（feature_toggles 中未配置时默认开启）。"""
        return self._settings.get("feature_toggles", {}).get(name, True)

    def _sync_background_services(self):
        """按 feature_toggles 同步 fps / music 后台服务的启停。"""
        from momoitor.services import fps as _fps
        from momoitor.services import music as _music
        if self._feature_on("fps"):
            _fps.start()
        else:
            _fps.stop()
        if self._feature_on("music"):
            _music.start()
        else:
            _music.stop()

    def get_settings(self):
        return self._settings

    def save_settings(self, settings):
        old_monitor = self._settings.get("display", {}).get("monitor", 0)
        old_fullscreen = self._settings.get("general", {}).get("fullscreen", True)
        old_on_top = self._settings.get("display", {}).get("on_top", True)
        old_opacity = self._settings.get("general", {}).get("window_opacity", 100)
        self._settings = settings
        if self._weather is not None:
            self._weather.invalidate()
        save_settings(settings)
        self._sync_background_services()
        if self._window:
            mon_idx = settings.get("display", {}).get("monitor", 0)
            monitor_changed = mon_idx != old_monitor
            fullscreen_changed = settings.get("general", {}).get("fullscreen") != old_fullscreen
            if settings.get("display", {}).get("on_top", True) != old_on_top:
                win_svc.set_on_top(self._window, settings.get("display", {}).get("on_top", True))
            new_opacity = settings.get("general", {}).get("window_opacity", 100)
            if new_opacity != old_opacity:
                win_svc.set_opacity(self._window, new_opacity)
            if settings.get("general", {}).get("fullscreen"):
                if monitor_changed or fullscreen_changed:
                    win_svc.move_to_monitor(self._window, mon_idx)
                    self._window.fullscreen = True
                    self._fullscreen = True
                    win_svc.set_caption(self._window, False)
            else:
                if fullscreen_changed:
                    self._window.fullscreen = False
                    self._fullscreen = False
                    win_svc.set_caption(self._window, True)
        logger.info("Settings saved")
        return True

    def dismiss_first_launch_hint(self):
        """用户已看到/关掉首次启动提示，持久化标记不再显示。"""
        self._settings.setdefault("general", {})["hint_dismissed"] = True
        save_settings(self._settings)
        return True

    def get_autostart(self):
        return autostart.is_enabled()

    def set_autostart(self, enabled):
        return autostart.enable() if enabled else autostart.disable()

    def check_for_updates(self):
        """检查 GitHub 最新版本。设置中关闭更新通知时返回 None。"""
        if not self._settings.get("general", {}).get("update_check_enabled", True):
            return None
        return check_latest_release()

    def get_app_info(self):
        """关于页信息：程序 / Python / pywebview / 硬件监控后端版本。"""
        import platform
        from importlib.metadata import version as _pkg_version
        try:
            pywebview_ver = _pkg_version("pywebview")
        except Exception:
            pywebview_ver = None
        return {
            "program": APP_VERSION,
            "author": APP_AUTHOR,
            "homepage": APP_HOMEPAGE,
            "github_repo": APP_GITHUB_REPO,
            "python": platform.python_version(),
            "pywebview": pywebview_ver,
            "backend": self._hw.get_backend_info(),
        }

    def get_run_identity(self):
        """调试用：返回程序当前运行身份（是否管理员 + 当前用户名）。"""
        return get_run_identity()

    def reload_ui(self):
        """调试用：重新加载 webview 界面（重新执行前端全部初始化逻辑）。"""
        logger.info("Reloading webview UI (requested from debug settings)")
        if self._window:
            self._window.evaluate_js("window.location.reload()")
            return True
        return False

    def get_server_info(self):
        """服务端模式信息：配置文件路径 + 浏览器可访问地址（用于保存时的提示框）。"""
        host = self._settings.get("server", {}).get("host", "0.0.0.0") or "0.0.0.0"
        port = int(self._settings.get("server", {}).get("port", 20622))
        loopback = host in ("0.0.0.0", "::", "")
        urls = []
        if loopback or host in ("127.0.0.1", "localhost"):
            urls.append("http://127.0.0.1:%d" % port)
        else:
            urls.append("http://%s:%d" % (host, port))
        if loopback:
            lan = _detect_lan_ip()
            if lan:
                urls.append("http://%s:%d" % (lan, port))
        return {
            "settings_file": SETTINGS_FILE,
            "host": host,
            "port": port,
            "urls": urls,
        }

    def get_monitors(self):
        return win_svc.get_monitors()

    def move_to_monitor(self, index):
        if self._window:
            return win_svc.move_to_monitor(self._window, index)
        return False

    def check_monitor(self):
        monitors = win_svc.get_monitors()
        idx = self._settings.get("display", {}).get("monitor", 0)
        return {"available": 0 <= idx < len(monitors), "count": len(monitors)}

    def set_caption(self, enabled: bool):
        """添加或移除原生标题栏（右上角最小化/最大化/关闭三键）。"""
        if self._window:
            win_svc.set_caption(self._window, bool(enabled))

    def toggle_fullscreen(self):
        if self._window:
            self._fullscreen = not self._fullscreen
            self._window.toggle_fullscreen()
            win_svc.set_caption(self._window, not self._fullscreen)

    def minimize_window(self):
        if self._window:
            win_svc.minimize(self._window)

    def close_monitor(self):
        if self._traffic is not None:
            self._traffic.stop()
        self._hw.close()

    def close_app(self):
        logger.info("Closing app")
        from momoitor.services import fps as _fps
        from momoitor.services import music as _music
        _fps.stop()
        _music.stop()
        self.close_monitor()
        if self._window:
            self._window.destroy()
        if self._server_backend:
            self._server_backend.stop()

    def _remove_window_shadow(self):
        try:
            hwnd = self._window.native_handle
            if not hwnd:
                return
            dwmapi = ctypes.windll.dwmapi
            MARGINS = ctypes.c_int * 4
            margins = MARGINS(0, 0, 0, 0)
            dwmapi.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(margins))
            logger.debug("Window shadow removed via DwmExtendFrameIntoClientArea")
        except Exception as e:
            logger.warning("Could not remove window shadow: {}", e)


def _detect_lan_ip():
    """探测本机局域网 IP（用于服务端模式提示框展示可访问地址）。

    用 UDP socket 连一个公网地址来让系统选出默认路由接口，
    不真正发送数据包，失败时返回 None。
    """
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
        if ip and ip != "0.0.0.0":
            return ip
    except Exception:
        pass
    return None
