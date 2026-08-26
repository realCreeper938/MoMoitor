"""Windows SMTC 音乐信息与播放控制。"""

import base64
import os
import shutil
import subprocess
import threading
import time
from loguru import logger

from momoitor.common import Poller, run_hidden

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
    "position_estimated": False,  # True 表示 position 为估算值（播放器未汇报进度）
    "session_id": "",      # 当前展示会话的 AUMID
    "session_index": 0,    # 当前展示会话在全部会话中的下标
    "session_count": 0,    # SMTC 会话总数
    "session_names": [],   # 全部会话的来源应用名（前端 tooltip 用）
}
_lock = threading.Lock()

# 歌词预测：估算播放位置状态。key 为曲目标识；pos 为该曲目已播放秒数
# （仅在 playing 时按墙钟累加，暂停冻结，切歌归零）；ts 为上次累加时刻。
_est = {"key": "", "pos": 0.0, "ts": 0.0}
# 时间线冻结检测：播放中且 duration>0 但 position 连续多次不变，
# 视为该播放器实际不更新进度（如部分 UWP/网页播放器）。
_tl_stale = {"pos": None, "n": 0}
# 最近一次可信的真实时间线位置：真实→估算交接时以此为基准，避免歌词回跳
_last_tl_pos = None
_last_track_key = ""
_cover_key = ""  # 已抓取过封面的曲目标识
_last_player = {"name": "", "path": ""}  # 上次播放音乐的进程信息
_mgr = None  # 复用的 SessionManager（每轮新建会产生大量 winrt 对象）
_selected = None  # 用户手动切换锁定的会话 (下标, AUMID)；None 表示自动选择


def _get_sessions():
    """返回当前全部 SMTC 会话列表（复用 SessionManager，失效时重建）。"""
    global _mgr
    if not _have_smtc:
        return []
    try:
        if _mgr is None:
            _mgr = SessionManager.request_async().get()
        return list(_mgr.get_sessions())
    except Exception as e:
        # 管理器可能已失效，丢弃后下一轮重建；也可能 winrt 异步运行时不完整
        # （如缺 winrt-Windows.Foundation），此时记录以便诊断。
        logger.debug("SMTC session manager unavailable: {}", e)
        _mgr = None
        return []


def _session_id(session):
    """安全读取会话的来源 AUMID。"""
    try:
        return session.source_app_user_model_id or ""
    except Exception:
        return ""


def _pick_session(sessions):
    """选择用于展示与控制的会话，返回 (会话, 在列表中的下标)。

    优先用户手动锁定的位置（用「下标 + AUMID」双重校验，以区分同一进程的
    多个同名会话），其次第一个正在播放的会话，再次系统当前会话，最后取
    第一个会话。手动锁定的会话已消失时回退自动选择。
    """
    global _selected
    if _selected is not None:
        pos, aumid = _selected
        if pos < len(sessions) and _session_id(sessions[pos]) == aumid:
            return sessions[pos], pos
        with _lock:
            _selected = None  # 锁定的会话已退出，回退自动选择
    for i, s in enumerate(sessions):
        try:
            if s.get_playback_info().playback_status.value == PlaybackStatus.PLAYING:
                return s, i
        except Exception:
            continue
    cur = None
    try:
        cur = _mgr.get_current_session() if _mgr else None
    except Exception:
        cur = None
    if cur is not None:
        cid = _session_id(cur)
        for i, s in enumerate(sessions):
            if _session_id(s) == cid:
                return cur, i
    return (sessions[0], 0) if sessions else (None, 0)


def _get_session():
    session, _ = _pick_session(_get_sessions())
    return session


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
    """在 PATH 中查找可执行文件路径。

    shutil.which 在 Windows 上自动按 PATHEXT 解析（兼容带 / 不带 .exe 后缀），
    替代此前每次起 where 子进程的实现。
    """
    return shutil.which(name) or ""


def _read_session(session, sessions, idx):
    """读取指定会话的全部展示信息并写入 _current（含多会话元数据）。"""
    global _last_track_key, _last_tl_pos
    names = [_get_app_name(_session_id(s)) for s in sessions]
    cur_id = _session_id(session)

    with _lock:
        _current["available"] = True
        _current["session_id"] = cur_id
        _current["session_index"] = idx
        _current["session_count"] = len(sessions)
        _current["session_names"] = names

    try:
        name = names[idx] if names else ""
        with _lock:
            _current["process_name"] = name
        _track_last_player(name, cur_id)
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

    # 媒体属性读取失败时回退用上次的曲目标识，保证估算状态机不中断
    track_key = locals().get("track_key") or _last_track_key

    try:
        info = session.get_playback_info()
        playing = (info.playback_status.value == PlaybackStatus.PLAYING)
    except Exception:
        playing = False

    position = None
    duration = 0.0
    try:
        tl = session.get_timeline_properties()
        position = max(0, tl.position.total_seconds())
        duration = max(0, (tl.end_time - tl.start_time).total_seconds())
    except Exception:
        pass

    with _lock:
        _current["playing"] = playing

        # ---- 播放位置：真实时间线优先，不可用/冻结时回退估算（歌词预测）----
        now_ts = time.monotonic()
        if track_key != _est["key"]:
            _est.update(key=track_key, pos=0.0, ts=now_ts)
            _tl_stale.update(pos=None, n=0)
        elif playing:
            _est["pos"] += max(0.0, now_ts - _est["ts"])
        _est["ts"] = now_ts

        stale = False
        tl_ok = position is not None and duration > 0
        if tl_ok:
            if playing:
                # 连续 >=3 轮（约3s）位置纹丝不动 → 该播放器不更新进度
                stale = (_tl_stale["pos"] == position)
                _tl_stale["n"] = (_tl_stale["n"] + 1) if stale else 0
                _tl_stale["pos"] = position
                stale = _tl_stale["n"] >= 2
            else:
                _tl_stale.update(pos=None, n=0)

        was_real = not _current.get("position_estimated", True)
        if tl_ok and not stale:
            _current["position"] = position
            _current["duration"] = duration
            _current["position_estimated"] = False
            # 估算时钟与真实进度持续对齐，保证随时可无缝接管
            _est["pos"] = float(position)
            _last_tl_pos = float(position)
        else:
            # 无法获取有效进度：用估算值推进（暂停时自然冻结）
            if not was_real and _last_tl_pos is not None:
                # 真实→估算交接：从最后可信位置继续，避免歌词回跳
                _est["pos"] = max(_est["pos"], _last_tl_pos)
            _current["position"] = round(_est["pos"], 1)
            _current["duration"] = 0.0
            _current["position_estimated"] = True


def switch_session():
    """切换到下一个媒体会话（存在多个 SMTC 会话时循环轮换）。

    按枚举下标循环（可区分同一进程的多个同名会话），切换后锁定该会话
    （播放控制也随之作用于它），并立即读取一次新会话信息，避免前端等待
    下一轮轮询。
    """
    global _last_track_key, _cover_key, _selected
    sessions = _get_sessions()
    if len(sessions) < 2:
        return False
    _, idx = _pick_session(sessions)
    nxt = (idx + 1) % len(sessions)
    with _lock:
        _selected = (nxt, _session_id(sessions[nxt]))
        # 重置曲目/封面缓存并清空旧信息，避免残留上一会话的内容
        _last_track_key = ""
        _cover_key = ""
        _est.update(key="", pos=0.0, ts=0.0)
        _tl_stale.update(pos=None, n=0)
        _current["title"] = ""
        _current["artist"] = ""
        _current["cover"] = ""
        _current["position"] = 0.0
        _current["duration"] = 0.0
        _current["position_estimated"] = False
    logger.info("Switched media session -> {}", _get_app_name(_session_id(sessions[nxt])))
    _read_session(sessions[nxt], sessions, nxt)
    return True


def _poll():
    """单次轮询；返回下一轮间隔（无会话时降频到 2s，其余 1s）。"""
    global _last_track_key, _cover_key, _selected
    try:
        sessions = _get_sessions()
        session, idx = _pick_session(sessions)
        if not session:
            with _lock:
                _selected = None
                _current["available"] = False
                _current["cover"] = ""
                _current["session_id"] = ""
                _current["session_index"] = 0
                _current["session_count"] = 0
                _current["session_names"] = []
            _last_track_key = ""
            _cover_key = ""
            _est.update(key="", pos=0.0, ts=0.0)
            _tl_stale.update(pos=None, n=0)
            return 2
        _read_session(session, sessions, idx)
    except Exception as e:
        logger.debug("Music poll: {}", e)
    return 1


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


_poller = Poller("music", 1.0, _poll)


def start():
    if not _have_smtc:
        return
    fresh = not _poller.running()
    _poller.start()
    if fresh:
        logger.info("Music polling started")


def stop():
    _poller.stop()
