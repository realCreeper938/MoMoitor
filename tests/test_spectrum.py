# -*- coding: utf-8 -*-
"""services.spectrum 频谱计算纯函数测试（不依赖 pyaudiowpatch）。"""

import numpy as np

from momoitor.services import spectrum as spec


def _sine(freq: float, rate: int = 48000, seconds: float = 0.1, amp: float = 0.5):
    t = np.arange(int(rate * seconds), dtype=np.float32) / rate
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def test_bands_length_and_range():
    spec._reset_roll_peak()
    bands = spec.compute_bands(_sine(440.0), 48000)
    assert len(bands) == spec.BANDS
    assert bands.dtype == np.float32
    assert (bands >= 0.0).all() and (bands <= 1.0).all()


def test_compute_bands_custom_count():
    """柱数可配置（设置 spectrum_bars），输出长度随之变化。"""
    spec._reset_roll_peak()
    for n in (12, 16, 48):
        bands = spec.compute_bands(_sine(1000.0), 48000, n=n)
        assert len(bands) == n
        assert (bands >= 0.0).all() and (bands <= 1.0).all()


def test_sine_energy_in_expected_band():
    """440Hz 正弦的能量应落在包含 440Hz 的频段，且高于高频段。"""
    spec._reset_roll_peak()
    bands = spec.compute_bands(_sine(440.0), 48000)
    edges = np.logspace(np.log10(spec.FREQ_LO), np.log10(spec.FREQ_HI), spec.BANDS + 1)
    idx = int(np.searchsorted(edges, 440.0) - 1)
    assert 0 <= idx < spec.BANDS
    assert bands[idx] > 0.5
    # 高于信号频率 2 个倍频程的频段应接近无声
    hi = [i for i in range(spec.BANDS) if edges[i] > 440.0 * 4]
    if hi:
        assert max(bands[i] for i in hi) < 0.05


def test_adaptive_gain_normalizes_loud_input():
    """大幅值输入经自适应增益后应被压回 [0,1]，且滚动峰值生效。"""
    loud = _sine(220.0, amp=0.99)
    bands = spec.compute_bands(loud, 48000)
    assert bands.max() <= 1.0
    assert bands.max() > 0.3  # 峰值柱应明显


def test_agc_suppresses_quiet_frame_after_loud_history():
    """响亮帧建立滚动峰值后，安静帧应被显著压低（自适应增益生效）。"""
    spec._reset_roll_peak()
    loud = _sine(220.0, amp=0.9)
    b_loud = spec.compute_bands(loud, 48000)
    assert b_loud.max() > 0.3
    quiet = _sine(440.0, amp=0.005)
    b_quiet = spec.compute_bands(quiet, 48000)
    assert b_quiet.max() < b_loud.max() / 3


def test_band_edges_cover_log_range():
    edges = np.logspace(np.log10(spec.FREQ_LO), np.log10(spec.FREQ_HI), spec.BANDS + 1)
    assert np.isclose(edges[0], spec.FREQ_LO)
    assert np.isclose(edges[-1], spec.FREQ_HI)
    assert (np.diff(edges) > 0).all()


def test_sensitivity_increases_response():
    """相同信号下，更高敏感度应得到更大的柱值（同等归一化基准下）。"""
    spec._reset_roll_peak()
    tone = _sine(440.0, amp=0.5)
    # 两条独立计算以模拟无历史峰值影响：用低敏感度先建立峰值再对比不成立，
    # 故改用同一信号分别以不同 sensitivity 直接比较其相对大小（共享滚动峰值）。
    spec._reset_roll_peak()
    low = spec.compute_bands(tone, 48000, sensitivity=0.5)
    high = spec.compute_bands(tone, 48000, sensitivity=2.0)
    # 敏感度翻 4 倍，敏感度大者峰值柱应明显更高
    assert high.max() > low.max()
