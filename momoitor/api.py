"""pywebview API 桥接 —— 薄门面，将调用委托给各服务模块。

主要方法:
- Api类: pywebview JS API桥接类，包含所有可从前端调用的方法
  - set_window(window): 设置窗口引用并初始化服务
  - get_data(): 获取硬件数据快照
  - get_settings()/save_settings(): 获取/保存设置
  - get_weather_info(): 获取天气和空气质量
  - close_app(): 关闭应用程序
- create_monitor(): 根据设置创建硬件监视器实例
- create_window(monitor): 创建pywebview窗口和API实例

主要变量:
- WEB_DIR: 前端web文件目录路径
- Api._settings: 当前设置字典
- Api._hw: 硬件服务实例
- Api._weather: 天气服务实例
"""

import ctypes
import os

import webview
from loguru import logger

from momoitor.config import (load_settings, save_settings, SETTINGS_FILE, APP_VERSION, WEB_DIR,
                             APP_AUTHOR, APP_HOMEPAGE, APP_GITHUB_REPO)
from momoitor.services import autostart, background as bg_svc, display as disp_svc, window as win_svc
from momoitor.services.brightness import adjust_brightness
from momoitor.services.volume import adjust_volume
from momoitor.services.hardware import HardwareService
from momoitor.services.system import get_time, get_sysinfo, get_top_processes, kill_process, scan_listening_ports, clean_memory
from momoitor.fps import get_current as get_fps
from momoitor.music import (
    get_current as get_music,
    get_last_player,
    launch_last_player,
    play_pause as music_play_pause,
    refresh_cover as music_refresh_cover,
    next_track as music_next,
    prev_track as music_prev,
)
from momoitor.services.calendar import show_calendar, hide_calendar, get_huangli
from momoitor.services.weather import WeatherService
from momoitor.services.holiday import HolidayService
from momoitor.services.traffic import TrafficService
from momoitor.services.lyrics import LyricsService
from momoitor.services.update import check_latest as check_latest_release


class Api:
    def __init__(self, monitor):
        self._window = None
        self._server_backend = None
        self._settings = load_settings()
        self._hw = HardwareService(monitor, self._settings)
        self._fullscreen = False
        self._random_bg = {}
        # 以下服务按需延迟初始化，避免启动时不必要的开销。
        # _weather / _holiday / _traffic / _lyrics 通过 __getattr__ 惰性创建。
        logger.info("API initialized")

    def __getattr__(self, name):
        if name == '_weather':
            svc = WeatherService(lambda: self._settings)
        elif name == '_holiday':
            svc = HolidayService()
        elif name == '_traffic':
            svc = TrafficService()
        elif name == '_lyrics':
            svc = LyricsService(lambda: self._settings)
        else:
            raise AttributeError(name)
        setattr(self, name, svc)
        return svc

    def set_window(self, window):
        self._window = window
        self._remove_window_shadow()
        self._traffic.start()

    def set_server_backend(self, backend):
        """服务端模式：注入 HTTP 后端用于关闭等操作。"""
        self._server_backend = backend

    # ── JS 桥接 ──────────────────────────────────────────────

    def js_log(self, level, message):
        log_func = getattr(logger, level, logger.debug)
        log_func("[JS] {}", message)

    # ── 硬件数据（委托给服务）────────────────────────────────

    def get_data(self):
        return self._hw.snapshot()

    def get_hw_names(self):
        return self._hw.get_hw_names()

    def get_gpu_list(self):
        return self._hw.get_gpu_list()

    def get_hw_detail(self):
        return self._hw.get_hw_detail()

    def change_backend(self, source):
        return self._hw.change_backend(source)

    def close_monitor(self):
        if '_traffic' in self.__dict__:
            self._traffic.stop()
        self._hw.close()

    def _feature_on(self, name):
        """对应功能开关是否开启（feature_toggles 中未配置时默认开启）。"""
        return self._settings.get("feature_toggles", {}).get(name, True)

    # ── 系统信息（委托给服务）────────────────────────────────

    def get_time(self):
        return get_time()

    def get_sysinfo(self):
        if not self._feature_on("sysinfo"):
            return {}
        return get_sysinfo()

    def get_idle_time(self):
        return win_svc.get_idle_time()

    def get_top_processes(self, sort_by="cpu", limit=1):
        if not self._feature_on("top_process"):
            return []
        return get_top_processes(sort_by, limit)

    def open_taskmgr(self):
        """启动 Windows 任务管理器并置于前台。"""
        import subprocess
        try:
            # 允许子进程获取前台窗口
            ctypes.windll.user32.AllowSetForegroundWindow(0xFFFFFFFF)
            subprocess.Popen(["taskmgr.exe"])
        except Exception as e:
            logger.warning(f"open_taskmgr failed: {e}")

    def open_external(self, url):
        """在系统默认浏览器中打开外部链接。仅允许 http/https。"""
        import webbrowser
        if not url or not url.lower().startswith(("http://", "https://")):
            return False
        try:
            webbrowser.open(url)
            return True
        except Exception as e:
            logger.warning(f"open_external failed: {e}")
            return False

    def kill_process(self, pid):
        if not self._feature_on("top_process"):
            return {"error": "disabled"}
        return kill_process(int(pid))

    # ── 端口扫描 ──────────────────────────────────────────────

    def get_listening_ports(self):
        return scan_listening_ports()

    # ── 天气（委托给服务）────────────────────────────────────

    def get_weather(self):
        if not self._feature_on("weather"):
            return {"error": "disabled"}
        return self._weather.get_now()

    def get_weather_detail(self):
        if not self._feature_on("weather"):
            return {"error": "disabled"}
        return self._weather.get_detail()

    def get_airquality(self):
        if not self._feature_on("weather"):
            return {"error": "disabled"}
        return self._weather.get_airquality()

    def get_weather_info(self):
        if not self._feature_on("weather"):
            return {"weather": {"error": "disabled"}, "air_quality": {"error": "disabled"}}
        weather = self._weather.get_now()
        air = self._weather.get_airquality()
        return {"weather": weather, "air_quality": air}

    def get_hardware_info(self):
        combined = self._hw.snapshot_with_detail()
        s = combined.get("snapshot", {})
        d = combined.get("detail", {})
        cpu = s.get("cpu", {})
        gpu = s.get("gpu", {})
        mem = s.get("mem", {})
        disks = s.get("disks", [])
        ds = s.get("disk_status", {})
        net = s.get("net", {})
        lines = []
        cpu_name = d.get("cpu", {}).get("name", "CPU")
        cores = d.get("cpu", {}).get("cores")
        threads = d.get("cpu", {}).get("threads")
        line = f"{cpu_name}"
        if cores: line += f" ({cores}C/{threads}T)" if threads else f" ({cores}C)"
        lines.append(line)
        lines.append(f"  Temp: {cpu.get('temp', '?')}C  Clock: {cpu.get('clock', '?')}MHz  Load: {cpu.get('load', '?')}%  Power: {cpu.get('power', '?')}W  Voltage: {cpu.get('voltage', '?')}V")
        gpu_name = d.get("gpu", {}).get("name", "GPU")
        lines.append(gpu_name)
        lines.append(f"  Temp: {gpu.get('temp', '?')}C  Load: {gpu.get('load', '?')}%  Power: {gpu.get('power', '?')}W")
        vram_u = gpu.get("vram_used_gb")
        vram_t = gpu.get("vram_total_gb")
        if vram_t: lines.append(f"  VRAM: {vram_u}/{vram_t} GB")
        if gpu.get("vram_temp"): lines.append(f"  VRAM Temp: {gpu['vram_temp']}C")
        mem_name = d.get("mem", {}).get("name", "Memory")
        mem_type = d.get("mem", {}).get("type", "")
        mem_speed = d.get("mem", {}).get("speed", "")
        lines.append(f"{mem_name} {mem_type} {mem_speed}")
        lines.append(f"  Used: {mem.get('used_gb', '?')}/{mem.get('total_gb', '?')} GB ({mem.get('percent', '?')}%)")
        if mem.get("temp"): lines.append(f"  Temp: {mem['temp']}C  Clock: {mem.get('clock', '?')}MHz")
        for dk in disks:
            lines.append(f"Disk {dk.get('letter', '?')}: {dk.get('used_gb', '?')}/{dk.get('total_gb', '?')} GB ({dk.get('percent', '?')}%)")
        if ds.get("temp") or ds.get("activity"):
            lines.append(f"Disk Status: Activity={ds.get('activity', '?')}% Temp={ds.get('temp', '?')}C Read={ds.get('read', '?')}B/s Write={ds.get('write', '?')}B/s")
        lines.append(f"Network ({net.get('name', '?')}): ↑{net.get('up', 0)}B/s ↓{net.get('down', 0)}B/s")
        return {"success": True, "info": "\n".join(lines)}

    def get_alerts(self):
        if not self._feature_on("weather"):
            return []
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

    def get_feature_toggles(self):
        return self._settings.get("feature_toggles", {})

    # ── 流量（委托给服务）────────────────────────────────────

    def get_traffic_today(self):
        if not self._feature_on("traffic"):
            return {"error": "disabled"}
        return self._traffic.get_today()

    def get_traffic_month(self, year, month):
        if not self._feature_on("traffic"):
            return {"error": "disabled"}
        return self._traffic.get_month(int(year), int(month))

    def get_traffic_top_processes(self, limit=5):
        if not self._feature_on("traffic"):
            return {"error": "disabled"}
        return self._traffic.get_top_processes(int(limit))

    # ── 音乐 / FPS（委托给服务）──────────────────────────────

    def get_music(self):
        if not self._feature_on("music"):
            return {"available": False}
        try:
            return get_music()
        except Exception as e:
            logger.warning("get_music failed: {}", e)
            return {"available": False, "error": str(e)}

    def get_lyrics(self, title, artist=""):
        if not self._settings.get("meting_api_base", "").strip():
            return {"lines": []}
        try:
            return {"lines": self._lyrics.get_lyrics(title or "", artist or "")}
        except Exception as e:
            logger.warning("get_lyrics failed: {}", e)
            return {"lines": []}

    def get_fps(self):
        if not self._feature_on("fps"):
            return {"fps": 0, "frametime": 0, "low1pct": 0, "avg_fps": 0, "p99_fps": 0}
        return get_fps()

    def get_last_player(self):
        return get_last_player()

    def launch_last_player(self):
        return launch_last_player()

    def music_play_pause(self):
        if not self._feature_on("music"):
            return {"error": "disabled"}
        return music_play_pause()

    def music_refresh_cover(self):
        if not self._feature_on("music"):
            return {"error": "disabled"}
        return music_refresh_cover()

    def music_next(self):
        if not self._feature_on("music"):
            return {"error": "disabled"}
        return music_next()

    def music_prev(self):
        if not self._feature_on("music"):
            return {"error": "disabled"}
        return music_prev()

    def adjust_volume(self, action, level=None):
        return adjust_volume(action, level)

    def adjust_brightness(self, action, level=None, monitor_index=None):
        idx = monitor_index if monitor_index is not None else self._settings.get("monitor", 0)
        return adjust_brightness(action, level, idx)

    # ── 壁纸 / Material You（委托给服务）─────────────────────

    def get_bg_list(self):
        if not self._feature_on("clock_bg"):
            return []
        return bg_svc.get_bg_list()

    def resolve_background_image(self, image=""):
        if not self._feature_on("clock_bg"):
            return ""
        return bg_svc.resolve_background(image, self._random_bg)

    def get_clock_bg_top_color(self, image=""):
        if not self._feature_on("clock_bg"):
            return ""
        return bg_svc.get_image_top_color(image, self._random_bg)

    def get_monet_colors(self, source="wallpaper", bg_image=""):
        return bg_svc.get_monet_colors(source, bg_image)

    def save_wallpaper(self, filename="", data_url=""):
        """前端导入壁纸：接收 base64 data URL，保存到用户壁纸目录，返回 wp/ 路径。"""
        if not self._feature_on("clock_bg"):
            return ""
        return bg_svc.save_wallpaper(filename, data_url)

    def delete_wallpaper(self, path=""):
        """删除用户壁纸（仅 wp/ 下用户导入的壁纸）。"""
        if not self._feature_on("clock_bg"):
            return False
        return bg_svc.delete_wallpaper(path)

    # ── 设置 / 自启动 ────────────────────────────────────────

    def clean_memory(self, deep=False):
        """回收所有进程的工作集 —— 点击内存占用百分比时触发。
        deep=True（快速重复点击）更激进地刷新工作集。"""
        try:
            return clean_memory(bool(deep))
        except Exception as e:
            logger.warning("clean_memory failed: {}", e)
            return {"ok": False, "error": str(e)}

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

    def get_settings(self):
        return self._settings

    def check_for_updates(self):
        """检查 GitHub 最新版本。设置中关闭更新通知时返回 None。"""
        if not self._settings.get("update_check_enabled", True):
            return None
        return check_latest_release()

    def get_server_info(self):
        """服务端模式信息：配置文件路径 + 浏览器可访问地址（用于保存时的提示框）。"""
        host = self._settings.get("server_host", "0.0.0.0") or "0.0.0.0"
        port = int(self._settings.get("server_port", 20622))
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

    def save_settings(self, settings):
        old_monitor = self._settings.get("monitor", 0)
        old_fullscreen = self._settings.get("fullscreen", True)
        self._settings = settings
        if '_weather' in self.__dict__:
            self._weather.invalidate()
        save_settings(settings)
        if self._window:
            mon_idx = settings.get("monitor", 0)
            monitor_changed = mon_idx != old_monitor
            fullscreen_changed = settings.get("fullscreen") != old_fullscreen
            if settings.get("fullscreen"):
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
        self._settings["hint_dismissed"] = True
        save_settings(self._settings)
        return True

    def get_autostart(self):
        return autostart.is_enabled()

    def set_autostart(self, enabled):
        return autostart.enable() if enabled else autostart.disable()

    # ── 显示器 / 窗口 ────────────────────────────────────────

    def get_monitors(self):
        return disp_svc.get_monitors()

    def move_to_monitor(self, index):
        if self._window:
            return win_svc.move_to_monitor(self._window, index)
        return False

    def check_monitor(self):
        monitors = disp_svc.get_monitors()
        idx = self._settings.get("monitor", 0)
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

    # ── 日历（委托给服务）────────────────────────────────────

    def show_calendar(self):
        return show_calendar(self._window)

    def hide_calendar(self):
        return hide_calendar(self._window)

    # ── 生命周期 ─────────────────────────────────────────────

    def close_app(self):
        logger.info("Closing app")
        from momoitor import fps as _fps
        from momoitor import music as _music
        _fps.stop()
        _music.stop()
        self.close_monitor()
        if self._window:
            self._window.destroy()
        if self._server_backend:
            self._server_backend.stop()

    # ── 辅助 ─────────────────────────────────────────────────

    def _remove_window_shadow(self):
        try:
            from ctypes import wintypes
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


def create_monitor():
    settings = load_settings()
    source = settings.get("data_source", "lhm")
    from momoitor.backends import LHMMonitor, HWiNFOMonitor
    if source == "hwinfo":
        return HWiNFOMonitor()
    return LHMMonitor()


def create_window(monitor):
    api = Api(monitor)
    index = os.path.join(WEB_DIR, "index.html")

    mon_idx = api._settings.get("monitor", 0)
    monitors = disp_svc.get_monitors()
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
    from momoitor import fps as _fps
    from momoitor import music as _music
    _fps.start()
    _music.start()
    return window, api


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


def create_api(monitor):
    """服务端模式：仅创建 Api 实例，不创建 webview 窗口。"""
    api = Api(monitor)
    from momoitor import fps as _fps
    from momoitor import music as _music
    _fps.start()
    _music.start()
    return api
