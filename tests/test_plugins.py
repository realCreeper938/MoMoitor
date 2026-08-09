"""插件系统测试：扫描、激活、主题/数据源、快照钩子、API 方法、前端资源收集、数据持久化。"""

import os
import sys

import pytest

import momoitor.config as config_mod
from momoitor.config import PROJECT_ROOT, _normalize_settings
from momoitor.plugins import PluginError, PluginManager

PLUGINS_DIR = os.path.join(PROJECT_ROOT, "plugins")

EXAMPLES = {"example_basic", "example_theme", "example_data_source", "example_widget"}


@pytest.fixture
def manager(monkeypatch):
    """构建一个指向真实示例插件目录、且不会写盘的 PluginManager。

    注意：必须拦截 manager 模块级的 save_settings（set_enabled 内部调用的是
    模块级函数而不是 self.save_settings），否则测试会写入真实的 settings.json。
    """
    settings = _normalize_settings({"plugins": {"enabled": list(EXAMPLES)}})
    m = PluginManager(settings)
    m._dir = PLUGINS_DIR
    monkeypatch.setattr("momoitor.plugins.manager.save_settings", lambda s: None)
    m.scan()
    return m


def make_manager(monkeypatch, enabled):
    """按需启用指定插件构建管理器（不写盘）。"""
    settings = _normalize_settings({"plugins": {"enabled": enabled}})
    m = PluginManager(settings)
    m._dir = PLUGINS_DIR
    monkeypatch.setattr("momoitor.plugins.manager.save_settings", lambda s: None)
    m.scan()
    return m


# ── 扫描 ──────────────────────────────────────────────────────


def test_scan_finds_examples(manager):
    assert set(manager._discovered.keys()) >= EXAMPLES
    assert manager._invalid == []


def test_scan_idempotent(manager):
    before = set(manager._discovered.keys())
    manager.scan()
    assert set(manager._discovered.keys()) == before


# ── 主题 / 数据源注册 ─────────────────────────────────────────


def test_theme_registered_via_register(manager):
    manager.activate()
    themes = manager.themes()
    theme = next((t for t in themes if t["value"] == "synthwave"), None)
    assert theme is not None
    assert theme["dark"] is True
    assert "--nord0" not in theme  # colors 是去前缀的 key
    assert "colors" in theme


def test_data_source_registered_via_register(manager):
    manager.activate()
    sources = manager.data_sources()
    source = next((d for d in sources if d["value"] == "demo"), None)
    assert source is not None
    assert source["label"]
    assert manager.create_monitor("demo") is not None


def test_themes_empty_before_activation(manager):
    assert manager.themes() == []
    assert manager.data_sources() == []


def test_register_theme_requires_colors(manager):
    manager.activate()
    with pytest.raises(PluginError):
        manager.register_theme("example_basic", {"value": "x"})


def test_register_theme_duplicate_value(manager):
    manager.activate()
    with pytest.raises(PluginError):
        manager.register_theme("example_basic", {"value": "synthwave", "colors": {"nord0": "#000"}})


def test_register_data_source_requires_callable(manager):
    manager.activate()
    with pytest.raises(PluginError):
        manager.register_data_source("example_basic", {"value": "x"}, None)


def test_register_data_source_duplicate_value(manager):
    manager.activate()
    with pytest.raises(PluginError):
        manager.register_data_source("example_basic", {"value": "demo"}, lambda: None)


# ── 激活 / 前端资源 ───────────────────────────────────────────


def test_activate_and_bundle(manager):
    manager.activate()
    assert set(manager._loaded.keys()) >= {"example_basic", "example_widget"}
    bundle = manager.frontend_bundle()
    ids = {p["id"] for p in bundle["plugins"]}
    assert "example_basic" in ids
    assert "example_widget" in ids
    example = next(p for p in bundle["plugins"] if p["id"] == "example_basic")
    assert example["head"] and "example-badge" in example["head"]
    assert example["body"] and "example-badge" in example["body"]
    assert example["scripts"] and "registerCard" in example["scripts"]


def test_frontend_bundle_excludes_disabled(monkeypatch):
    m = make_manager(monkeypatch, ["example_basic"])
    m.activate()
    ids = {p["id"] for p in m.frontend_bundle()["plugins"]}
    assert ids == {"example_basic"}


def test_frontend_bundle_skips_plugins_without_frontend(manager):
    manager.activate()
    ids = {p["id"] for p in manager.frontend_bundle()["plugins"]}
    # example_theme / example_data_source 没有 frontend 目录，不应出现在 bundle 中
    assert "example_theme" not in ids
    assert "example_data_source" not in ids


# ── 数据源 Monitor ────────────────────────────────────────────


def test_create_plugin_monitor(manager):
    manager.activate()
    mon = manager.create_monitor("demo")
    assert mon is not None
    snap = mon.snapshot()
    for key in ("cpu", "gpu", "mem", "disks", "disk_status", "net"):
        assert key in snap
    assert snap["net"]["name"] == "demo"
    assert "load" in snap["cpu"]
    assert mon.get_backend_info()["name"] == "Demo"


def test_create_monitor_unknown_returns_none(manager):
    manager.activate()
    assert manager.create_monitor("does-not-exist") is None


def test_create_monitor_without_activation_returns_none(manager):
    # 未激活时数据源未注册
    assert manager.create_monitor("demo") is None


# ── 快照钩子 ──────────────────────────────────────────────────


def test_snapshot_hooks_chain(manager):
    manager.activate()
    data = {"cpu": {"load": 1}}
    out = manager.apply_snapshot_hooks(data)
    assert out is data
    assert out["example"]["time"] > 0  # example_basic 的 on_snapshot 注入


def test_snapshot_hook_errors_swallowed(manager):
    manager.activate()
    manager.add_hook("snapshot", lambda data: (_ for _ in ()).throw(RuntimeError("boom")))
    data = {"cpu": {}}
    out = manager.apply_snapshot_hooks(data)
    assert out is data


# ── 钩子执行 ──────────────────────────────────────────────────


def test_hooks_startup_shutdown_settings_saved(manager):
    events = []
    manager.add_hook("startup", lambda: events.append("startup"))
    manager.add_hook("shutdown", lambda: events.append("shutdown"))
    manager.add_hook("settings_saved", lambda s: events.append(("saved", s["general"]["language"])))

    manager.run_startup_hooks()
    manager.run_shutdown_hooks()
    manager.run_shutdown_hooks()  # 幂等：只执行一次
    manager._run_settings_saved_hooks(manager._settings)

    assert events.count("startup") == 1
    assert events.count("shutdown") == 1
    assert ("saved", manager._settings["general"]["language"]) in events


def test_add_hook_unknown_name_raises(manager):
    with pytest.raises(PluginError):
        manager.add_hook("nope", lambda: None)


def test_add_hook_non_callable_raises(manager):
    with pytest.raises(PluginError):
        manager.add_hook("startup", "not-a-function")


# ── API 方法 ──────────────────────────────────────────────────


def test_api_method_exposed(manager):
    manager.activate()

    class FakeApi:
        def __init__(self):
            self._window = None

    api = FakeApi()
    manager.attach(api)
    assert hasattr(api, "example_hello")
    assert api.example_hello("Tester") == "Hello, Tester! (from example_basic)"


def test_add_api_method_conflict(manager):
    manager.activate()
    with pytest.raises(PluginError):
        manager.add_api_method("example_hello", lambda: None)
    with pytest.raises(PluginError):
        manager.add_api_method("get_settings", lambda: None)


# ── 设置开关 ──────────────────────────────────────────────────


def test_set_enabled_mutates_settings(manager):
    assert manager.set_enabled("example_theme", True) == {"ok": True, "restart_required": True}
    assert "example_theme" in manager.get_settings()["plugins"]["enabled"]
    assert manager.set_enabled("example_theme", False)["ok"] is True
    assert "example_theme" not in manager.get_settings()["plugins"]["enabled"]
    assert manager.set_enabled("nope", True)["ok"] is False


def test_set_enabled_uses_latest_api_settings(manager):
    """开关插件必须基于 Api 的最新设置，而不是启动快照，否则会覆盖后续保存的配置。"""

    class FakeApi:
        def __init__(self, settings):
            self._settings = settings
            self._window = None

    # 模拟前端后续保存：Api 持有比启动快照更新的设置（如修改了 language）
    api_settings = _normalize_settings({"plugins": {"enabled": []}})
    api_settings["general"]["language"] = "en"
    manager.attach(FakeApi(api_settings))
    manager.set_enabled("example_theme", True)
    assert manager.get_settings()["plugins"]["enabled"] == ["example_theme"]
    # language 必须保留 Api 的最新值，而不是被启动快照覆盖
    assert manager.get_settings()["general"]["language"] == "en"


def test_manager_save_settings_syncs_api(manager):
    class FakeApi:
        def __init__(self, settings):
            self._settings = settings
            self._window = None

    api = FakeApi(_normalize_settings({}))
    manager.attach(api)
    settings = manager.get_settings()
    settings["general"]["language"] = "fr"
    assert manager.save_settings(settings) is True
    assert api._settings["general"]["language"] == "fr"


def test_set_enabled_preserves_saved_settings_on_disk(tmp_path, monkeypatch):
    """回归：开关插件必须基于 Api 最新设置写盘，不能丢失用户随后保存的其他配置。

    模拟真实流程：启动时磁盘有设置 → Api 持有最新设置并改了语言/刷新间隔/布局
    → 开关插件 → 重新读盘必须同时包含插件改动与之前的修改。
    """
    monkeypatch.setattr(config_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config_mod, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config_mod, "_settings_cache", None)

    config_mod.save_settings(_normalize_settings({"plugins": {"enabled": ["example_widget"]}}))

    m = PluginManager(config_mod.load_settings())
    m._dir = PLUGINS_DIR
    m.scan()
    m.activate()

    # 模拟前端通过 Api 修改设置（此时尚未重新读盘）
    api_settings = config_mod.load_settings()
    api_settings["general"]["language"] = "en"
    api_settings["general"]["refresh_interval"] = 2000
    api_settings["layout"]["rows"] = 8

    class FakeApi:
        def __init__(self, settings):
            self._settings = settings
            self._window = None

    m.attach(FakeApi(api_settings))

    assert m.set_enabled("example_theme", True)["restart_required"] is True

    # 重新从磁盘读取：之前的修改必须保留，插件开关结果必须生效
    monkeypatch.setattr(config_mod, "_settings_cache", None)
    on_disk = config_mod.load_settings()
    assert on_disk["general"]["language"] == "en"
    assert on_disk["general"]["refresh_interval"] == 2000
    assert on_disk["layout"]["rows"] == 8
    assert "example_widget" in on_disk["plugins"]["enabled"]
    assert "example_theme" in on_disk["plugins"]["enabled"]


# ── 列表 / 无效插件 ───────────────────────────────────────────


def test_plugins_list_type_and_sort(manager):
    items = manager.plugins_list()
    assert all(i["type"] == "plugin" for i in items)
    ids = [i["id"] for i in items]
    assert ids == sorted(ids, key=str.lower)
    assert "example_basic" in ids


def test_invalid_plugin_reported():
    m = PluginManager(_normalize_settings({"plugins": {"enabled": []}}))
    m._dir = os.path.join(PROJECT_ROOT, "tests", "fixtures", "plugins")
    m.scan()
    bad = {i["id"]: i for i in m.plugins_list()}
    assert "broken" in bad
    assert bad["broken"]["valid"] is False
    assert bad["broken"]["error"]
    assert bad["broken"]["type"] == "plugin"
