"""API 媒体/内容 mixin —— 音乐、歌词、FPS、流量、壁纸、音量与亮度。

MediaMixin 汇聚展示类卡片（音乐 / 歌词 / FPS / 流量 / 壁纸）与控制类
（音量 / 亮度）的 JS 桥接方法，并统一做 feature_toggles 开关判断。
"""

from loguru import logger

from momoitor.services import background as bg_svc
from momoitor.services.brightness import adjust_brightness
from momoitor.services.fps import get_current as get_fps
from momoitor.services.music import (
    get_current as get_music,
    get_last_player,
    launch_last_player,
    next_track as music_next,
    play_pause as music_play_pause,
    prev_track as music_prev,
    refresh_cover as music_refresh_cover,
)
from momoitor.services.volume import adjust_volume


class MediaMixin:
    """音乐 / FPS / 流量 / 壁纸 / 音量亮度 的 JS 桥接方法。"""

    # ── 音乐 / FPS ───────────────────────────────────────────

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

    # ── 壁纸 / Material You ──────────────────────────────────

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