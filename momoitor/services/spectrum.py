"""音频频谱可视化服务 —— WASAPI 全局回环捕获 + FFT，经 evaluate_js 推送前端。

设计要点：
- 仅当媒体播放（SMTC 状态 PLAYING）时打开默认输出设备的回环流，暂停立即关闭；
- 设置 music.spectrum 关闭时 start() 不创建线程、不导入 pyaudiowpatch，
  stop() 彻底结束线程并释放音频资源；
- 音频回调内只做 FFT 分频与自适应增益归一化（约 23fps 自然更新率）；
  工作线程按 ~20fps 把柱值推给前端 window.__spectrum，由前端插值绘制，
  暂停/关闭时推送空数组令其平滑淡出。
"""

import json
import sys
import threading
import time

import numpy as np
from loguru import logger

BANDS = 28
CHUNK = 2048
PUSH_INTERVAL = 0.05   # 推送间隔（20fps），前端自行插值补间
SILENCE_RMS = 0.0005   # 静音门限：低于此值视为无声
FREQ_LO, FREQ_HI = 40.0, 15000.0

_bands = [0.0] * BANDS          # 最近一帧频谱（音频回调写入，工作线程读取）
_lock = threading.Lock()
_thread = None
_stop_evt = None
_window_getter = None
_settings_getter = None         # 读取 music.spectrum_* 配置（柱数等）

# 以下资源仅由工作线程创建与访问
_pya = None      # pyaudio.PyAudio 实例
_stream = None   # 回环输入流


def _bar_count() -> int:
    """当前设置的频谱柱数（钳制到合理范围）。"""
    n = BANDS
    try:
        if _settings_getter:
            n = int((_settings_getter().get("music", {}) or {}).get("spectrum_bars") or BANDS)
    except Exception:
        pass
    return max(8, min(64, n))


def _sensitivity() -> float:
    """当前设置的频谱敏感度（越高越早满格）。"""
    s = 1.0
    try:
        if _settings_getter:
            s = float((_settings_getter().get("music", {}) or {}).get("spectrum_sensitivity") or 100)
    except Exception:
        pass
    return max(0.5, min(2.5, s / 100.0))


def compute_bands(mono: np.ndarray, rate: int, n: int = BANDS, sensitivity: float = 1.0) -> np.ndarray:
    """单帧 PCM 转频谱柱值：加汉宁窗 FFT 后按对数频段取峰值，自适应增益归一化。

    返回长度 n 的数组，元素范围 [0, 1]。纯函数，便于测试。
    sensitivity（范围 ~0.5..2.5）为归一化敏感度：越大，同等音量下柱值越早满格。
    """
    win = np.hanning(len(mono)).astype(np.float32)
    spec = np.abs(np.fft.rfft(mono * win))
    freqs = np.fft.rfftfreq(len(mono), 1.0 / rate)
    edges = np.logspace(np.log10(FREQ_LO), np.log10(FREQ_HI), n + 1)
    raw = np.zeros(n, dtype=np.float32)
    for i in range(n):
        m = (freqs >= edges[i]) & (freqs < edges[i + 1])
        if m.any():
            raw[i] = float(spec[m].max())
    # 自适应增益：跟踪约 2 秒衰减的滚动峰值，音乐音量变化无需手动调阈值
    peak = max(float(raw.max()) * 1.2, _roll_peak() * 0.995)
    _set_roll_peak(peak)
    denom = max(peak / max(sensitivity, 0.1), 1e-6)
    return np.clip(raw / denom, 0.0, 1.0)


_roll = {"v": 1e-6}  # 滚动峰值（仅音频回调线程读写）


def _roll_peak() -> float:
    return _roll["v"]


def _set_roll_peak(v: float) -> None:
    _roll["v"] = v


def _is_music_playing() -> bool:
    """SMTC 当前会话是否处于播放状态。"""
    from momoitor.services import music as _music
    cur = _music.get_current()
    return bool(cur.get("available") and cur.get("playing"))


def _push(data) -> None:
    """把柱值推给前端；窗口不可用或已关闭时静默跳过。"""
    try:
        win = _window_getter() if _window_getter else None
        if win is not None:
            win.evaluate_js(
                "window.__spectrum&&window.__spectrum(" + json.dumps(data) + ")"
            )
    except Exception:
        pass


def _open_stream():
    """打开默认输出设备的全局回环流。失败抛异常，由调用方冷却重试。"""
    global _pya, _stream
    import pyaudiowpatch as pyaudio  # 延迟导入：未启用功能时不加载

    _pya = pyaudio.PyAudio()
    wasapi = _pya.get_host_api_info_by_type(pyaudio.paWASAPI)
    spk = _pya.get_device_info_by_index(wasapi["defaultOutputDevice"])
    if not spk.get("isLoopbackDevice"):
        for lb in _pya.get_loopback_device_info_generator():
            if spk["name"] in lb["name"]:
                spk = lb
                break
    ch = int(spk["maxInputChannels"]) or 2
    rate = int(spk["defaultSampleRate"])
    logger.info("Spectrum loopback: {} ({}ch @{}Hz)", spk["name"], ch, rate)

    def cb(in_data, frame_count, time_info, status):
        n = _bar_count()
        x = np.frombuffer(in_data, dtype=np.int16).astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(x * x)))
        if ch > 1:
            x = x.reshape(-1, ch).mean(axis=1)
        vals = compute_bands(x, rate, n, _sensitivity()) if rms > SILENCE_RMS else np.zeros(n, dtype=np.float32)
        global _bands
        with _lock:
            _bands = [round(float(v), 3) for v in vals]
        return (None, pyaudio.paContinue)

    _stream = _pya.open(
        format=pyaudio.paInt16,
        channels=ch,
        rate=rate,
        frames_per_buffer=CHUNK,
        input=True,
        input_device_index=spk["index"],
        stream_callback=cb,
    )


def _close_stream():
    """关闭回环流并释放 PyAudio（幂等）。"""
    global _pya, _stream, _bands
    if _stream is not None:
        try:
            _stream.stop_stream()
            _stream.close()
        except Exception:
            pass
        _stream = None
    if _pya is not None:
        try:
            _pya.terminate()
        except Exception:
            pass
        _pya = None
    with _lock:
        _bands = [0.0] * BANDS
    _reset_roll_peak()


def _reset_roll_peak():
    _roll["v"] = 1e-6


def _worker():
    """工作线程：管理回环流开关（跟随播放状态）并按固定频率推送柱值。"""
    global _stream
    last_push = 0.0
    cooldown_until = 0.0
    while not _stop_evt.is_set():
        now = time.time()
        try:
            playing = _is_music_playing()
            if playing and _stream is None and now >= cooldown_until:
                try:
                    _open_stream()
                    _reset_roll_peak()
                except Exception as e:
                    logger.warning("Spectrum stream open failed: {}", e)
                    cooldown_until = time.time() + 2.0
            elif not playing and _stream is not None:
                _close_stream()
                _push([])  # 通知前端淡出
            if _stream is not None and now - last_push >= PUSH_INTERVAL:
                with _lock:
                    data = list(_bands)
                _push(data)
                last_push = time.time()
        except Exception as e:
            logger.warning("Spectrum worker error: {}", e)
            _close_stream()
            cooldown_until = time.time() + 2.0
        _stop_evt.wait(0.033)
    _close_stream()  # 线程退出前释放，避免与 stop() 的兜底清理产生竞态泄漏


def start(window_getter, settings_getter=None) -> bool:
    """启动频谱服务（幂等）；返回是否处于运行状态。

    仅 Windows 桌面模式可用；线程为 daemon，不阻塞退出。
    """
    global _thread, _stop_evt, _window_getter, _settings_getter
    if sys.platform != "win32":
        return False
    _window_getter = window_getter
    _settings_getter = settings_getter
    if _thread is not None and _thread.is_alive():
        return True
    _stop_evt = threading.Event()
    _thread = threading.Thread(target=_worker, name="spectrum", daemon=True)
    _thread.start()
    logger.info("Spectrum service started")
    return True


def stop() -> None:
    """彻底停止：结束线程、关闭回环流、清零状态。"""
    global _thread, _stop_evt, _window_getter, _settings_getter
    if _stop_evt is not None:
        _stop_evt.set()
    if _thread is not None and _thread.is_alive():
        _thread.join(timeout=2.0)
    _thread = None
    _stop_evt = None
    _window_getter = None
    _settings_getter = None
    _close_stream()
    _push([])


def running() -> bool:
    return _thread is not None and _thread.is_alive()
