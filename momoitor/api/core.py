"""API 核心 mixin —— 状态、生命周期、设置、窗口控制。

ApiCore 提供 Api.__init__ 需要的全部内部状态（_window / _settings / _hw 等）、
按需惰性创建的服务、通用开关判断，以及设置 / 自启动 / 关于 / 窗口 / 生命周期
等不直接属于硬件或媒体卡片的能力。由 api/__init__.py 的 Api 组合使用。
"""

import ctypes
import json

from loguru import logger

from momoitor.config import (APP_AUTHOR, APP_GITHUB_REPO, APP_HOMEPAGE, APP_VERSION,
                             SETTINGS_FILE, load_settings, save_settings,
                             server_conf)
from momoitor.services import autostart, session as session_watch, window as win_svc
from momoitor.services import tray as tray_svc
from momoitor.services.system import get_run_identity
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
        self._traffic = None
        self._lyrics = None
        self._lock_was_visible = False
        logger.info("API initialized")

    @property
    def weather(self):
        if self._weather is None:
            self._weather = WeatherService(lambda: self._settings)
        return self._weather

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
        # 去阴影需要真实 HWND（window.native），而此刻窗口尚未启动，native 为 None。
        # 延迟到 shown 事件（窗口已显示、native 已赋值）再执行，避免拿不到本程序
        # 窗口句柄而误操作其它窗口。注意：透明度不在此处应用——启动时后续的
        # fullscreen / 标题栏（boot.js initDisplay）会用 SetWindowPos/Bounds 重建
        # 窗口样式、清除 WS_EX_LAYERED，导致透明度丢失；故统一由前端在初始化
        # 完成后调用 apply_window_opacity() 应用。
        window.events.shown += self._apply_native_window_setup
        self.traffic.start()
        self._start_session_watch()

    def _apply_native_window_setup(self, *args):
        self._remove_window_shadow()

    def apply_window_opacity(self):
        """窗口初始化完成后应用原生透明度（读取设置中 general.window_opacity）。

        必须在 fullscreen / 标题栏等窗口样式重置之后调用，否则会被覆盖。
        返回是否成功。
        """
        if not self._window:
            return False
        return win_svc.set_opacity(
            self._window, self._settings.get("general", {}).get("window_opacity", 100)
        )

    def _start_session_watch(self):
        """锁屏瞬间隐藏窗口，避免锁屏界面跟随本程序所在显示器；解锁后恢复。"""
        session_watch.start(self._on_session_locked, self._on_session_unlocked)

    def _on_session_locked(self):
        if not self._window:
            return
        self._lock_was_visible = win_svc.is_visible(self._window)
        if self._lock_was_visible:
            try:
                self._window.hide()
            except Exception as e:
                logger.warning("Hide window on lock failed: {}", e)

    def _on_session_unlocked(self):
        if not self._window or not self._lock_was_visible:
            return
        self._lock_was_visible = False
        try:
            self._window.show()
        except Exception as e:
            logger.warning("Show window on unlock failed: {}", e)

    def set_server_backend(self, backend):
        """服务端模式：注入 HTTP 后端用于关闭等操作。"""
        self._server_backend = backend
        tray_svc.refresh()

    def js_log(self, level, message):
        log_func = getattr(logger, level, logger.debug)
        log_func("[JS] {}", message)

    def _feature_on(self, name):
        """对应功能开关是否开启（feature_toggles 中未配置时默认开启）。"""
        return self._settings.get("feature_toggles", {}).get(name, True)

    def _sync_background_services(self):
        """按 feature_toggles 同步 fps / music / spectrum 后台服务的启停。"""
        from momoitor.services import fps as _fps
        from momoitor.services import music as _music
        from momoitor.services import spectrum as _spectrum
        if self._feature_on("fps"):
            _fps.start()
        else:
            _fps.stop()
        if self._feature_on("music"):
            _music.start()
        else:
            _music.stop()
        self._sync_spectrum()

    def _sync_spectrum(self):
        """频谱服务：需音乐功能开启、设置打开且存在 webview 窗口，否则彻底停止。"""
        from momoitor.services import spectrum as _spectrum
        enabled = (
            self._feature_on("music")
            and self._settings.get("music", {}).get("spectrum") is True
            and self._window is not None
        )
        if enabled:
            window_getter = lambda: self._window  # noqa: E731
            settings_getter = lambda: self._settings  # noqa: E731
            _spectrum.start(window_getter, settings_getter)
        else:
            _spectrum.stop()

    def get_settings(self):
        return self._settings

    def save_settings(self, settings):
        old_display = self._settings.get("display", {})
        old_target = win_svc.display_target(old_display)
        old_fullscreen = self._settings.get("general", {}).get("fullscreen", True)
        old_on_top = old_display.get("on_top", True)
        old_opacity = self._settings.get("general", {}).get("window_opacity", 100)
        self._settings = settings
        if self._weather is not None:
            self._weather.invalidate()
        save_settings(settings)
        self._sync_background_services()
        if self._window:
            new_display = settings.get("display", {})
            target = win_svc.display_target(new_display)
            new_fullscreen = settings.get("general", {}).get("fullscreen", True)
            monitor_changed = target != old_target
            fullscreen_changed = new_fullscreen != old_fullscreen
            if monitor_changed:
                win_svc.move_to_monitor(self._window, target)
            fullscreen_on = new_fullscreen
            if fullscreen_changed or (monitor_changed and fullscreen_on):
                if fullscreen_on:
                    self._window.fullscreen = True
                    self._fullscreen = True
                    win_svc.set_caption(self._window, False)
                else:
                    self._window.fullscreen = False
                    self._fullscreen = False
                    win_svc.set_caption(self._window, True)
            if new_display.get("on_top", True) != old_on_top:
                win_svc.set_on_top(self._window, new_display.get("on_top", True))
            new_opacity = settings.get("general", {}).get("window_opacity", 100)
            if new_opacity != old_opacity:
                win_svc.set_opacity(self._window, new_opacity)
        # 托盘等外部入口修改设置后，前端缓存 window._appSettings 会滞后；
        # 统一推送受影响分组，避免前端下次整包保存时用旧值覆盖（前端自身的
        # 保存也会走到这里，回推相同值无副作用）。
        self._push_settings_to_ui(settings)
        tray_svc.refresh()
        logger.info("Settings saved")
        return True

    def _push_settings_to_ui(self, settings):
        """把变更的设置分组同步到前端缓存（见 save_settings 内说明）。"""
        if not self._window:
            return
        try:
            groups = {g: settings[g] for g in ("general", "display", "server") if g in settings}
            payload = json.dumps(groups, ensure_ascii=False)
            self._window.evaluate_js(
                "window.__syncExternalSettings && window.__syncExternalSettings(%s)" % payload
            )
        except Exception as e:
            logger.debug("Push settings to UI failed: {}", e)

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
        conf = server_conf(self._settings)
        host = conf.get("host") or "0.0.0.0"
        port = int(conf.get("port") or 20622)
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
        target = win_svc.display_target(self._settings.get("display", {}))
        _, matched = win_svc.find_display(target, monitors)
        return {"available": matched, "count": len(monitors)}

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
        session_watch.stop()
        if self._traffic is not None:
            self._traffic.stop()
        from momoitor.services import spectrum as _spectrum
        _spectrum.stop()
        self._hw.close()

    def close_app(self):
        logger.info("Closing app")
        tray_svc.stop()
        from momoitor.services import fps as _fps
        from momoitor.services import hr as _hr
        from momoitor.services import music as _music
        _fps.stop()
        _music.stop()
        _hr.stop()
        self.close_monitor()
        if self._window:
            self._window.destroy()
        if self._server_backend:
            self._server_backend.stop()

    def _remove_window_shadow(self):
        hwnd = win_svc._resolve_hwnd(self._window)
        if not hwnd:
            return
        try:
            dwmapi = ctypes.windll.dwmapi
            MARGINS = ctypes.c_int * 4
            margins = MARGINS(0, 0, 0, 0)
            dwmapi.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(margins))
            logger.debug("Window shadow removed via DwmExtendFrameIntoClientArea")
        except Exception as e:
            logger.debug("Could not remove window shadow: {}", e)


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
