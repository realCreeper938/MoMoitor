"""Windows SMTC 音乐信息与播放控制。

主要方法:
- get_current(): 获取当前音乐播放信息
- play_pause(): 播放/暂停音乐
- next_track(): 下一曲
- prev_track(): 上一曲
- start(): 启动音乐轮询线程
- stop(): 停止音乐轮询

主要变量:
- _have_smtc: SMTC可用性标志
- _have_buffer: Buffer类可用性标志
- _current: 当前音乐信息字典 {available, playing, title, artist, cover,
  process_name, position, duration}
- _lock: 线程锁
- _running: 轮询运行标志
- _last_track_key: 上一次曲目标识（用于检测曲目变化）
"""

import base64
import threading
import time
from loguru import logger

_have_smtc = False
_have_buffer = False
try:
    import winrt.windows.media.control as wmc
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    )
    _have_smtc = True
except ImportError:
    logger.warning("winrt not installed — music disabled")

try:
    from winrt.windows.storage.streams import Buffer
    _have_buffer = True
except ImportError:
    pass

_current = {
    "available": False,
    "playing": False,
    "title": "",
    "artist": "",
    "cover": "",
    "process_name": "",
    "position": 0.0,
    "duration": 0.0,
}
_lock = threading.Lock()
_running = False
_last_track_key = ""
_cover_key = ""  # 已抓取过封面的曲目标识


def _get_session():
    if not _have_smtc:
        return None
    try:
        mgr = SessionManager.request_async().get()
        return mgr.get_current_session()
    except Exception:
        return None


def get_current():
    with _lock:
        return dict(_current)


def play_pause():
    session = _get_session()
    if session:
        try:
            session.try_toggle_play_pause_async().get()
            return True
        except Exception as e:
            logger.error("play_pause failed: {}", e)
    return False


def next_track():
    session = _get_session()
    if session:
        try:
            session.try_skip_next_async().get()
            return True
        except Exception as e:
            logger.error("next_track failed: {}", e)
    return False


def prev_track():
    session = _get_session()
    if session:
        try:
            session.try_skip_previous_async().get()
            return True
        except Exception as e:
            logger.error("prev_track failed: {}", e)
    return False


def _get_app_name(aumid):
    """从 SMTC 来源应用的 AUMID 提取友好的应用名。"""
    if not aumid:
        return ""
    try:
        # 去掉 "!" 之后的内容
        aumid = aumid.split("!")[0]
        # 取下划线之前的部分（PublisherId 后缀）
        # 例: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0" -> "SpotifyAB.SpotifyMusic"
        # 例: "chrome.exe" -> "chrome.exe"
        before_underscore = aumid.split("_")[0]
        parts = before_underscore.split(".")
        if len(parts) >= 2:
            candidate = parts[-1]
            # 若最后一部分是文件扩展名，则取前一部分
            if candidate.lower() in ('exe', 'dll', 'com'):
                return parts[-2]
            return candidate
        return parts[0]
    except Exception:
        return ""


def _poll():
    global _last_track_key, _cover_key
    while _running:
        try:
            session = _get_session()
            if not session:
                with _lock:
                    _current["available"] = False
                    _current["cover"] = ""
                _last_track_key = ""
                _cover_key = ""
                time.sleep(2)
                continue

            with _lock:
                _current["available"] = True

            try:
                source = session.source_app_user_model_id
                with _lock:
                    _current["process_name"] = _get_app_name(source)
            except Exception:
                pass

            try:
                props = session.try_get_media_properties_async().get()
                title = props.title or ""
                artist = props.artist or ""
                with _lock:
                    _current["title"] = title
                    _current["artist"] = artist

                track_key = f"{title}|{artist}"
                if track_key != _last_track_key:
                    _last_track_key = track_key
                # 每轮都尝试抓取封面；_fetch_cover 内部按 _cover_key 缓存，
                # 已抓取的曲目立即返回。这样切歌或封面流尚未就绪（瞬时失败）时
                # 都会在下一轮自动重试，避免封面迟迟不更新。
                _fetch_cover(props, track_key)
            except Exception:
                pass

            try:
                info = session.get_playback_info()
                with _lock:
                    _current["playing"] = (info.playback_status.value == PlaybackStatus.PLAYING)
            except Exception:
                pass

            try:
                tl = session.get_timeline_properties()
                with _lock:
                    _current["position"] = max(0, tl.position.total_seconds())
                    _current["duration"] = max(0, (tl.end_time - tl.start_time).total_seconds())
            except Exception:
                pass

        except Exception as e:
            logger.debug("Music poll: {}", e)
        time.sleep(1)


def _fetch_cover(props, track_key=None):
    """从媒体属性中获取封面，转换为 base64 data URL。
    每个曲目只抓取一次；同一曲目的重复属性变化复用已缓存封面，避免重复 I/O。

    发生瞬时失败（如切歌时流尚未就绪）时，保留旧封面且不设置 _cover_key，
    以便下一轮轮询重试。
    """
    global _cover_key
    key = track_key if track_key is not None else _last_track_key
    if not _have_buffer:
        _cover_key = key
        return
    if _cover_key == key:
        return
    try:
        thumb_ref = props.thumbnail
        if not thumb_ref:
            # 该歌曲确实没有封面 —— 停止重试
            with _lock:
                _current["cover"] = ""
            _cover_key = key
            return
        stream = thumb_ref.open_read_async().get()
        if not stream:
            return
        try:
            if stream.size == 0 or stream.size > 10_000_000:
                # 流尚未就绪（切歌后常见）—— 下一轮轮询重试
                return
            size = int(stream.size)
            buf = Buffer(size)
            stream.read_async(buf, size, 0).get()
            data = bytes(buf)
            b64 = base64.b64encode(data).decode("ascii")
            with _lock:
                _current["cover"] = f"data:image/jpeg;base64,{b64}"
            _cover_key = key
        finally:
            try:
                stream.close()
            except Exception:
                pass
    except Exception as e:
        logger.debug("Cover fetch failed: {}", e)
        # 瞬时错误 —— 下一轮轮询重试，保留旧封面


def refresh_cover():
    """强制刷新当前曲目的封面（例如在播放/暂停切换后）。返回当前音乐信息字典。"""
    global _cover_key
    if not _have_smtc:
        return get_current()
    try:
        session = _get_session()
        if not session:
            return get_current()
        props = session.try_get_media_properties_async().get()
        title = props.title or ""
        artist = props.artist or ""
        track_key = f"{title}|{artist}"
        with _lock:
            _current["title"] = title
            _current["artist"] = artist
        _cover_key = ""  # 使缓存失效，以便 _fetch_cover 重新读取
        _fetch_cover(props, track_key)
        try:
            info = session.get_playback_info()
            with _lock:
                _current["playing"] = (info.playback_status.value == PlaybackStatus.PLAYING)
        except Exception:
            pass
    except Exception as e:
        logger.debug("refresh_cover failed: {}", e)
    return get_current()


def start():
    global _running
    if not _have_smtc:
        return
    if _running:
        return
    _running = True
    threading.Thread(target=_poll, daemon=True).start()
    logger.info("Music polling started")


def stop():
    global _running
    _running = False
