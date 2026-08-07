"""媒体服务 —— 音乐信息、播放控制、FPS。

主要方法:
- get_music(): 获取当前音乐播放信息
- get_fps(): 获取当前FPS信息
- music_play_pause(): 播放/暂停音乐
- music_next(): 下一曲
- music_prev(): 上一曲

主要变量:
- 无特别重要的模块级变量
"""

from loguru import logger

from momoitor import fps
from momoitor import music


def get_music() -> dict:
    return music.get_current()


def get_fps() -> dict:
    return fps.get_current()


def get_last_player() -> dict:
    return music.get_last_player()


def launch_last_player() -> bool:
    return music.launch_last_player()


def music_play_pause() -> bool:
    return music.play_pause()


def music_refresh_cover() -> dict:
    """强制刷新当前曲目的封面并返回最新音乐信息。"""
    return music.refresh_cover()


def music_next() -> bool:
    return music.next_track()


def music_prev() -> bool:
    return music.prev_track()
