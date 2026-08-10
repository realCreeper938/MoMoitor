"""性能测试：对项目各数据获取路径做耗时基准测试（pytest-benchmark）。

- 每个测试对应一条数据获取路径，会话结束时输出按 group 分组的报告表
  （min/max/mean/median/rounds/iterations 等），配合 `-s` 查看。
- 数据源不可用（硬件后端初始化失败、非 Windows、HWiNFO 共享内存缺失、
  RTSS 未运行等）时自动跳过对应测试，不影响其余数据源。
- 慢速调用（硬件、进程枚举、端口扫描等）固定轮次控制整体耗时；
  网络型数据只测本地缓存命中路径，不发起真实请求。

运行:
    python -m pytest tests/test_perf.py -s -v
整体回归: python -m pytest -q
"""

import sys

import pytest


def _bench_slow(benchmark, fn, rounds=5):
    """慢速数据获取：固定轮次 + 1 次热身，避免自动校准拉长总时长。"""
    benchmark.pedantic(fn, rounds=rounds, iterations=1, warmup_rounds=1)


# 供 _build_jwt 基准使用的临时 Ed25519 私钥（本地生成，无真实密钥）
def _new_ed25519_key() -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key = Ed25519PrivateKey.generate()
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


_ED25519_KEY = _new_ed25519_key()


def _fake_snapshot():
    """与真实 monitor.snapshot() 同形状的示例数据（含 NaN，走重建路径）。"""
    return {
        "cpu": {"clock": 3700.0, "temp": 61.0, "power": 45.2, "load": 12.3, "voltage": 1.2},
        "gpu": {"temp": float("nan"), "power": 15.7, "vram_used_gb": 2.2, "vram_total_gb": 8.0, "load": 4.0, "vram_temp": 60.0},
        "mem": {"used_gb": 14.0, "total_gb": 31.3, "percent": 44.6, "temp": None, "volt": None, "clock": None},
        "disks": [
            {"letter": "C:", "used_gb": 136.0, "total_gb": 250.0, "percent": 54.5},
            {"letter": "D:", "used_gb": 183.0, "total_gb": 703.0, "percent": 26.0},
        ],
        "disk_status": {"activity": None, "temp": None, "read": None, "write": None},
        "net": {"up": 720, "down": 430, "name": "WLAN"},
    }


_LRC_SAMPLE = "\n".join(
    f"[{i // 60:02d}:{i % 60:02d}.{(i * 37) % 1000:03d}] 第 {i} 行歌词内容示例文本"
    for i in range(1, 60)
)


# ── 硬件后端（真实 LHM / HWiNFO）──────────────────────────────


@pytest.fixture(scope="module")
def lhm_monitor():
    """共享同一 LHM 实例（避免重复 .NET 初始化）；不可用则跳过。"""
    from momoitor.backends import LHMMonitor
    try:
        monitor = LHMMonitor()
        monitor.snapshot()  # 触发首次初始化，耗时不计入基准
    except Exception as e:
        pytest.skip(f"LHM backend unavailable: {e}")
    yield monitor
    try:
        monitor.close()
    except Exception:
        pass


@pytest.fixture(scope="module")
def hw_service(lhm_monitor):
    import copy

    from momoitor.config import DEFAULT_SETTINGS
    from momoitor.services.hardware import HardwareService
    return HardwareService(lhm_monitor, copy.deepcopy(DEFAULT_SETTINGS))


@pytest.mark.benchmark(group="hardware")
class TestHardwareBackend:
    def test_lhm_snapshot(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lhm_monitor.snapshot)

    def test_lhm_cpu(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lhm_monitor.get_cpu)

    def test_lhm_gpu(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lambda: lhm_monitor.get_gpu(0))

    def test_lhm_gpu_list(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lhm_monitor.get_gpu_list)

    def test_lhm_memory(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lhm_monitor.get_memory)

    def test_lhm_disks(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lhm_monitor.get_disks)

    def test_lhm_disk_status(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lhm_monitor.get_disk_status)

    def test_lhm_network(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lhm_monitor.get_network)

    def test_lhm_hw_names(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lhm_monitor.get_hw_names)

    def test_lhm_hw_detail(self, benchmark, lhm_monitor):
        _bench_slow(benchmark, lambda: lhm_monitor.get_hw_detail(0))

    def test_service_snapshot(self, benchmark, hw_service):
        _bench_slow(benchmark, hw_service.snapshot)

    def test_service_snapshot_with_detail(self, benchmark, hw_service):
        _bench_slow(benchmark, hw_service.snapshot_with_detail)

    def test_hwinfo_snapshot(self, benchmark):
        from momoitor.backends import HWiNFOMonitor
        try:
            monitor = HWiNFOMonitor()
            monitor.snapshot()
        except Exception:
            pytest.skip("HWiNFO shared memory unavailable")
        _bench_slow(benchmark, monitor.snapshot)


# ── 系统信息 / 进程 / 端口 ─────────────────────────────────────


@pytest.mark.benchmark(group="system")
class TestSystem:
    def test_get_time(self, benchmark):
        from momoitor.services.system import get_time
        benchmark(get_time)

    def test_get_sysinfo(self, benchmark):
        from momoitor.services.system import get_sysinfo
        benchmark(get_sysinfo)

    @pytest.mark.skipif(sys.platform != "win32", reason="Windows only")
    def test_get_idle_time(self, benchmark):
        from momoitor.services import window as win_svc
        benchmark(win_svc.get_idle_time)

    def test_get_top_processes_cpu(self, benchmark):
        from momoitor.services.system import get_top_processes
        _bench_slow(benchmark, lambda: get_top_processes("cpu", 10))

    def test_get_top_processes_mem(self, benchmark):
        from momoitor.services.system import get_top_processes
        _bench_slow(benchmark, lambda: get_top_processes("mem", 10))

    def test_proclist_fast_path(self, benchmark):
        from momoitor.services import proclist
        _bench_slow(benchmark, lambda: proclist.get_top_processes("cpu", 10))

    def test_proclist_psutil_fallback(self, benchmark):
        from momoitor.services import system as sys_mod
        _bench_slow(benchmark, sys_mod._get_all_processes, rounds=2)

    def test_scan_listening_ports(self, benchmark):
        from momoitor.services.system import scan_listening_ports
        _bench_slow(benchmark, scan_listening_ports)

    def test_system_theme_mode(self, benchmark):
        from momoitor.services.system import get_system_theme_mode
        benchmark(get_system_theme_mode)

    @pytest.mark.skipif(sys.platform != "win32", reason="Windows only")
    def test_get_monitors(self, benchmark):
        from momoitor.services import window as win_svc
        _bench_slow(benchmark, win_svc.get_monitors)


# ── 缓存与数据清理工具 ─────────────────────────────────────────


@pytest.mark.benchmark(group="cache")
class TestCache:
    def test_ttl_cache_hit(self, benchmark):
        from momoitor.services.cache import TTLCache
        c = TTLCache()
        c.set("now", {"text": "晴", "temp": "28"})
        benchmark(lambda: c.get("now", 600))

    def test_ttl_cache_miss(self, benchmark):
        from momoitor.services.cache import TTLCache
        c = TTLCache()
        benchmark(lambda: c.get("now", 600))

    def test_sanitize_fast_path(self, benchmark):
        from momoitor.services.hardware import HardwareService
        data = _fake_snapshot()
        data["gpu"]["temp"] = 51.6  # 无 NaN/Inf：命中快速路径
        benchmark(lambda: HardwareService._sanitize(data))

    def test_sanitize_rebuild_path(self, benchmark):
        from momoitor.services.hardware import HardwareService
        benchmark(lambda: HardwareService._sanitize(_fake_snapshot()))


# ── 天气（JWT 签名 + 缓存命中路径）─────────────────────────────


@pytest.mark.benchmark(group="weather")
class TestWeather:
    def test_build_jwt(self, benchmark):
        from momoitor.services.weather import _build_jwt
        benchmark(lambda: _build_jwt("key_id", "project_id", _ED25519_KEY))

    def test_get_now_cache_hit(self, benchmark):
        from momoitor.services.weather import WeatherService
        settings = {"weather": {"lat": "1", "lon": "2", "key_id": "a", "project_id": "b", "private_key": "c"}}
        svc = WeatherService(lambda: settings)
        svc._cache.set("now", {"text": "晴", "temp": "28", "city": "北京"})
        benchmark(svc.get_now)

    def test_get_airquality_cache_hit(self, benchmark):
        from momoitor.services.weather import WeatherService
        settings = {"weather": {"lat": "1", "lon": "2", "key_id": "a", "project_id": "b", "private_key": "c"}}
        svc = WeatherService(lambda: settings)
        svc._cache.set("airquality", {"indexes": [], "pollutants": []})
        benchmark(svc.get_airquality)

    def test_get_alerts_cache_hit(self, benchmark):
        from momoitor.services.weather import WeatherService
        settings = {"weather": {"lat": "1", "lon": "2", "key_id": "a", "project_id": "b", "private_key": "c"}}
        svc = WeatherService(lambda: settings)
        svc._cache.set("alerts", [])
        benchmark(svc.get_alerts)


# ── 日历 / 黄历 / 节假日 ───────────────────────────────────────


@pytest.mark.benchmark(group="calendar")
class TestCalendar:
    def test_huangli(self, benchmark):
        from momoitor.services.calendar import get_huangli
        _bench_slow(benchmark, get_huangli)

    def test_holiday_cache_hit(self, benchmark):
        from momoitor.services.calendar import HolidayService
        svc = HolidayService()
        svc._cache.set(2026, {"2026-10-01": {"holiday": True, "name": "国庆节"}})
        benchmark(lambda: svc.get_year(2026))


# ── 歌词（解析 + SQLite 缓存命中）──────────────────────────────


@pytest.mark.benchmark(group="lyrics")
class TestLyrics:
    def test_parse_lrc(self, benchmark):
        from momoitor.services.lyrics import LyricsService
        benchmark(lambda: LyricsService._parse_lrc(_LRC_SAMPLE))

    def test_cache_hit(self, benchmark, tmp_path, monkeypatch):
        from momoitor.services import lyrics as lyrics_mod
        monkeypatch.setattr(lyrics_mod, "DB_PATH", str(tmp_path / "lyrics.db"))
        svc = lyrics_mod.LyricsService(lambda: {"music": {"meting_api_base": "http://127.0.0.1:3000"}})
        svc._save_cache("netease|test|artist", _LRC_SAMPLE)
        benchmark(lambda: svc.get_lyrics("test", "artist"))


# ── 流量记录（SQLite 读取）─────────────────────────────────────


@pytest.fixture()
def traffic_svc(tmp_path, monkeypatch):
    from momoitor.services import traffic as traffic_mod
    from momoitor.services.db import get_conn
    monkeypatch.setattr(traffic_mod, "DB_PATH", str(tmp_path / "traffic.db"))
    svc = traffic_mod.TrafficService()
    with get_conn(traffic_mod.DB_PATH) as conn:
        for d in range(1, 11):
            conn.execute(
                "INSERT OR REPLACE INTO daily_traffic (date, up, down) VALUES (?, ?, ?)",
                (f"2026-08-{d:02d}", d * 1024, d * 2048),
            )
        for i in range(1, 6):
            conn.execute(
                "INSERT OR REPLACE INTO proc_cache (pid, name, up, down, updated_at) VALUES (?, ?, ?, ?, ?)",
                (1000 + i, f"proc{i}", i * 1000, i * 2000, 123.0),
            )
        conn.commit()
    return svc


@pytest.mark.benchmark(group="traffic")
class TestTraffic:
    def test_get_today(self, benchmark, traffic_svc):
        benchmark(traffic_svc.get_today)

    def test_get_month(self, benchmark, traffic_svc):
        benchmark(lambda: traffic_svc.get_month(2026, 8))

    def test_top_processes(self, benchmark, traffic_svc):
        benchmark(lambda: traffic_svc.get_top_processes(10))


# ── 媒体 / 背景（读缓存与图片处理）─────────────────────────────


@pytest.mark.benchmark(group="media")
class TestMedia:
    def test_fps_current(self, benchmark):
        from momoitor.services import fps
        benchmark(fps.get_current)

    def test_music_current(self, benchmark):
        from momoitor.services import music
        benchmark(music.get_current)


@pytest.mark.benchmark(group="background")
class TestBackground:
    def test_get_bg_list(self, benchmark):
        from momoitor.services.background import get_bg_list
        benchmark(get_bg_list)

    def test_image_top_color(self, benchmark):
        from momoitor.services.background import get_bg_list, get_image_top_color
        lst = get_bg_list()
        if not lst:
            pytest.skip("no background images available")
        image = next((x for x in lst if x.startswith("bg/")), None) or lst[0]
        _bench_slow(benchmark, lambda: get_image_top_color(image))
