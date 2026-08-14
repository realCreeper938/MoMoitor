"""Windows SMTC 音乐信息与播放控制。"""

import base64
import os
import subprocess
import threading
import time
from loguru import logger

from momoitor.common import run_hidden

_have_smtc = False
_have_buffer = False
try:
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
_thread = None
_last_track_key = ""
_cover_key = ""  # 已抓取过封面的曲目标识
_last_player = {"name": "", "path": ""}  # 上次播放音乐的进程信息
_mgr = None  # 复用的 SessionManager（每轮新建会产生大量 winrt 对象）


def _get_session():
    global _mgr
    if not _have_smtc:
        return None
    try:
        if _mgr is None:
            _mgr = SessionManager.request_async().get()
        return _mgr.get_current_session()
    except Exception:
        # 管理器可能已失效，丢弃后下一轮重建
        _mgr = None
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


def seek_track(position: float):
    """跳转到指定时间点（秒）。"""
    session = _get_session()
    if session:
        try:
            # winrt 将 TimeSpan 映射为 100ns 整数刻度，不能用 timedelta
            ticks = int(float(position) * 10_000_000)
            session.try_change_playback_position_async(ticks).get()
            return True
        except Exception as e:
            logger.error("seek_track failed: {}", e)
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


def _track_last_player(name, aumid):
    """记录上次播放音乐的进程信息，供「未播放时点击播放」自动启动使用。

    仅在进程名变化时尝试解析可执行文件路径（psutil 遍历 + UWP 包信息），
    避免在每轮轮询中重复做昂贵的进程查找。
    """
    global _last_player
    if not name:
        return
    with _lock:
        if _last_player["name"] == name:
            return
    path = _resolve_player_path(name, aumid)
    with _lock:
        _last_player = {"name": name, "path": path}
        logger.info("Last music player recorded: {} -> {}", name, path or "(no path)")


def _resolve_player_path(name, aumid):
    """解析播放器进程的可执行文件路径。

    优先匹配正在运行的进程名；若为 UWP 应用（AUMID 含 '!'），退回识别其
    AppUserModelID 对应的包，以便后续通过 shell:AppsFolder 启动。
    """
    try:
        import psutil
        name_lower = name.lower()
        for proc in psutil.process_iter(['name', 'exe']):
            try:
                pname = (proc.info.get('name') or '').lower()
                pexe = proc.info.get('exe') or ''
                if pname == name_lower or pname.startswith(name_lower + '.exe'):
                    if pexe and os.path.exists(pexe):
                        return pexe
            except Exception:
                continue
    except Exception:
        pass
    # UWP 应用：aumid 形如 "Publisher.App_publisherhash!AppId"
    if aumid and "!" in aumid:
        return "shell:AppsFolder\\" + aumid
    return ""


def get_last_player():
    """返回上次播放音乐的进程信息 {"name": ..., "path": ...}。"""
    with _lock:
        return dict(_last_player)


def launch_last_player():
    """启动上次播放音乐的进程。返回是否成功启动。"""
    with _lock:
        info = dict(_last_player)
    name = info.get("name", "")
    path = info.get("path", "")
    if not name:
        return False
    try:
        if path and path.startswith("shell:AppsFolder"):
            # UWP 应用通过 explorer 启动
            subprocess.Popen(["explorer.exe", path], cwd=os.environ.get("WINDIR", "C:\\Windows"))
            logger.info("Launching UWP music player: {}", path)
            return True
        exe = path
        if not exe:
            exe = _find_in_path(name)
        if not exe:
            logger.warning("Cannot find executable for music player '{}'", name)
            return False
        subprocess.Popen([exe], cwd=os.path.dirname(exe) or None)
        logger.info("Launching music player: {}", exe)
        return True
    except Exception as e:
        logger.error("launch_last_player failed: {}", e)
        return False


def _find_in_path(name):
    """在 PATH 中查找可执行文件路径（兼容带 / 不带 .exe 后缀）。"""
    candidates = [name]
    if not name.lower().endswith(".exe"):
        candidates.append(name + ".exe")
    for cand in candidates:
        resolved = run_hidden(["where", cand], text=True)
        if resolved.returncode == 0 and resolved.stdout.strip():
            first = resolved.stdout.strip().splitlines()[0].strip()
            if os.path.exists(first):
                return first
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
                name = _get_app_name(source)
                with _lock:
                    _current["process_name"] = name
                _track_last_player(name, source)
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
    global _running, _thread
    if not _have_smtc:
        return
    if _running:
        return
    _running = True
    if _thread and _thread.is_alive():
        # stop() 后立即 start() 时旧线程仍在运行，直接复用避免重复轮询
        return
    _thread = threading.Thread(target=_poll, daemon=True)
    _thread.start()
    logger.info("Music polling started")


def stop():
    global _running
    _running = False
