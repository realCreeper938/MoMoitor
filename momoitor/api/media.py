"""API 媒体/内容 mixin —— 音乐、歌词、FPS、流量、壁纸、音量与亮度。

MediaMixin 汇聚展示类卡片（音乐 / 歌词 / FPS / 流量 / 壁纸）与控制类
（音量 / 亮度）的 JS 桥接方法，并统一做 feature_toggles 开关判断。
"""

from momoitor.api._util import feature_gated, safe
from momoitor.services import background as bg_svc
from momoitor.services.brightness import adjust_brightness
from momoitor.services.fps import get_current as get_fps
from momoitor.services.music import (
    get_current as get_music,
    launch_last_player,
    next_track as music_next,
    play_pause as music_play_pause,
    prev_track as music_prev,
    seek_track as music_seek,
    switch_session as music_switch_session,
)
from momoitor.services.volume import adjust_volume


class MediaMixin:
    """音乐 / FPS / 流量 / 壁纸 / 音量亮度 的 JS 桥接方法。

    展示类卡片（音乐 / 歌词 / FPS / 流量 / 壁纸）与控制类（音量 / 亮度）
    方法统一通过 feature_toggles 开关判断。
    """

    @feature_gated("music", {"available": False})
    @safe("get_music", {"available": False}, include_error=True)
    def get_music(self):
        return get_music()

    @safe("get_lyrics", {"lines": []})
    def get_lyrics(self, title, artist=""):
        if not self._settings.get("music", {}).get("meting_api_base", "").strip():
            return {"lines": []}
        return {"lines": self.lyrics.get_lyrics(title or "", artist or "")}

    @safe("clear_lyrics_cache", {"ok": False, "cleared": 0}, include_error=True)
    def clear_lyrics_cache(self):
        """清除全部已缓存的歌词（设置 → 数据 → 歌词），返回 {ok, cleared}。"""
        cleared = self.lyrics.invalidate()
        return {"ok": True, "cleared": cleared}

    @feature_gated("fps", {"fps": 0, "frametime": 0, "low1pct": 0, "avg_fps": 0, "p99_fps": 0})
    def get_fps(self):
        return get_fps()

    def launch_last_player(self):
        return launch_last_player()

    @feature_gated("music", {"error": "disabled"})
    def music_play_pause(self):
        return music_play_pause()

    @feature_gated("music", {"error": "disabled"})
    def music_next(self):
        return music_next()

    @feature_gated("music", {"error": "disabled"})
    def music_prev(self):
        return music_prev()

    @feature_gated("music", {"error": "disabled"})
    def music_seek(self, position):
        return music_seek(position)

    @feature_gated("music", {"error": "disabled"})
    def music_switch_session(self):
        """切换到下一个 SMTC 媒体会话（多个会话时循环）。"""
        return music_switch_session()

    def adjust_volume(self, action, level=None):
        return adjust_volume(action, level)

    def adjust_brightness(self, action, level=None, monitor_index=None):
        idx = monitor_index if monitor_index is not None else self._settings.get("display", {}).get("monitor", 0)
        return adjust_brightness(action, level, idx)

    @feature_gated("traffic", {"error": "disabled"})
    def get_traffic_today(self):
        return self.traffic.get_today()

    @feature_gated("traffic", {"error": "disabled"})
    def get_traffic_month(self, year, month):
        return self.traffic.get_month(int(year), int(month))

    @feature_gated("traffic", {"error": "disabled"})
    def get_traffic_top_processes(self, limit=5):
        return self.traffic.get_top_processes(int(limit))

    @feature_gated("clock_bg", [])
    def get_bg_list(self):
        return bg_svc.get_bg_list()

    @feature_gated("clock_bg", "")
    def resolve_background_image(self, image=""):
        return bg_svc.resolve_background(image)

    @feature_gated("clock_bg", "")
    def get_clock_bg_top_color(self, image=""):
        return bg_svc.get_image_top_color(image)

    @feature_gated("clock_bg", "")
    def save_wallpaper(self, filename="", data_url=""):
        """前端导入壁纸：接收 base64 data URL，保存到用户壁纸目录，返回 wp/ 路径。"""
        return bg_svc.save_wallpaper(filename, data_url)

    @feature_gated("clock_bg", False)
    def delete_wallpaper(self, path=""):
        """删除用户壁纸（仅 wp/ 下用户导入的壁纸）。"""
        return bg_svc.delete_wallpaper(path)