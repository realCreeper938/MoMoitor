"""API 层插件集成测试：前端调用流程、开关插件与设置的往返一致性。"""

import pytest

import momoitor.config as config_mod
from momoitor.api.core import ApiCore
from momoitor.api.plugins import PluginMixin
from momoitor.config import PROJECT_ROOT, _normalize_settings
from momoitor.plugins import PluginManager

import os

PLUGINS_DIR = os.path.join(PROJECT_ROOT, "plugins")


class FakeMonitor:
    """最小的硬件后端替身，满足 HardwareService / ApiCore 的构造要求。"""

    def __init__(self):
        self._closed = False

    def get_backend_info(self):
        return {"name": "fake", "version": "0.0.1"}

    def snapshot(self, gpu_index=0):
        return {"cpu": {}, "gpu": {}, "mem": {}, "disks": [], "disk_status": {}, "net": {}}

    def get_hw_names(self):
        return {"cpu": "CPU", "gpu": "GPU", "mem": "Memory", "disk": "Disk"}

    def get_gpu_list(self):
        return []

    def get_hw_detail(self, gpu_index=None):
        return {"cpu": {}, "gpu": {}, "mem": {}}

    def get_memory(self):
        return {}

    def close(self):
        self._closed = True


def make_api(tmp_path, monkeypatch, enabled=None):
    """构造一个指向临时设置文件的 Api（ApiCore + PluginMixin），并挂上真实插件管理器。

    enabled 为启动时即启用的插件列表：主题/数据源等能力只在 activate() 时注册，
    运行期 set_plugin_enabled 只改设置、不立即注册能力（下次启动生效）。
    """
    monkeypatch.setattr(config_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config_mod, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config_mod, "_settings_cache", None)

    settings = _normalize_settings({})
    if enabled:
        settings["plugins"]["enabled"] = list(enabled)
    config_mod.save_settings(settings)

    manager = PluginManager(config_mod.load_settings())
    manager._dir = PLUGINS_DIR
    manager.scan()
    manager.activate()

    # 让 ApiCore.__init__ 使用我们自己的管理器（而不是全局单例），避免测试污染
    monkeypatch.setattr("momoitor.api.core.get_manager", lambda: manager)

    class Api(ApiCore, PluginMixin):
        pass

    api = Api(FakeMonitor())
    return api, manager


# ── PluginMixin 直接委托 ──────────────────────────────────────


def test_plugin_mixin_delegation():
    class FakeManager:
        def plugins_list(self):
            return ["list"]

        def set_enabled(self, pid, enabled):
            return {"ok": True, "restart_required": True}

        def frontend_bundle(self):
            return {"plugins": []}

        def themes(self):
            return []

        def data_sources(self):
            return []

    class Dummy(PluginMixin):
        def __init__(self):
            self._plugin_manager = FakeManager()

    api = Dummy()
    assert api.get_plugins() == ["list"]
    assert api.set_plugin_enabled("x", True)["restart_required"] is True
    assert api.get_plugin_frontend() == {"plugins": []}
    assert api.get_plugin_themes() == []
    assert api.get_plugin_data_sources() == []


# ── Api 层开关插件与设置往返 ──────────────────────────────────


def test_api_get_plugins_lists_examples(tmp_path, monkeypatch):
    api, _ = make_api(tmp_path, monkeypatch)
    ids = {p["id"] for p in api.get_plugins()}
    assert {"example_basic", "example_theme", "example_data_source", "example_widget"} <= ids
    assert all(p["type"] == "plugin" for p in api.get_plugins())


def test_api_toggle_plugin_then_save_settings_keeps_enabled(tmp_path, monkeypatch):
    """前端流程：开关插件后保存设置，插件开关结果必须保留在磁盘上。"""
    api, manager = make_api(tmp_path, monkeypatch)

    # 打开一个插件
    res = api.set_plugin_enabled("example_theme", True)
    assert res["restart_required"] is True
    assert "example_theme" in api.get_settings()["plugins"]["enabled"]

    # 模拟前端保存设置（api.save_settings），payload 来自 get_settings
    s = api.get_settings()
    s["general"]["language"] = "en"
    api.save_settings(s)

    # 磁盘上必须同时包含语言修改与插件开关
    assert config_mod.load_settings()["general"]["language"] == "en"
    assert "example_theme" in config_mod.load_settings()["plugins"]["enabled"]


def test_api_disable_plugin_then_save_settings_keeps_disabled(tmp_path, monkeypatch):
    api, manager = make_api(tmp_path, monkeypatch)

    api.set_plugin_enabled("example_theme", True)
    assert "example_theme" in api.get_settings()["plugins"]["enabled"]

    # 再关掉
    api.set_plugin_enabled("example_theme", False)
    s = api.get_settings()
    s["general"]["language"] = "zh"
    api.save_settings(s)

    on_disk = config_mod.load_settings()
    assert "example_theme" not in on_disk["plugins"]["enabled"]
    assert on_disk["general"]["language"] == "zh"


def test_api_settings_save_roundtrip_preserves_plugins(tmp_path, monkeypatch):
    """get_settings → 修改其它配置 → save_settings → 插件列表不被清空。"""
    api, manager = make_api(tmp_path, monkeypatch)

    api.set_plugin_enabled("example_basic", True)

    s = api.get_settings()
    assert "example_basic" in s["plugins"]["enabled"]
    s["general"]["refresh_interval"] = 3000
    api.save_settings(s)

    loaded = config_mod.load_settings()
    assert loaded["general"]["refresh_interval"] == 3000
    assert "example_basic" in loaded["plugins"]["enabled"]


def test_api_get_plugin_frontend_only_enabled(tmp_path, monkeypatch):
    api, manager = make_api(tmp_path, monkeypatch, enabled=["example_basic"])

    bundle = api.get_plugin_frontend()
    ids = {p["id"] for p in bundle["plugins"]}
    # example_widget 未启用，不应出现在 bundle
    assert "example_basic" in ids
    assert "example_widget" not in ids


def test_api_get_plugin_themes_and_data_sources(tmp_path, monkeypatch):
    api, manager = make_api(tmp_path, monkeypatch, enabled=["example_theme", "example_data_source"])

    themes = api.get_plugin_themes()
    assert any(t["value"] == "synthwave" for t in themes)

    sources = api.get_plugin_data_sources()
    assert any(d["value"] == "demo" for d in sources)


def test_api_save_settings_then_toggle_keeps_latest(tmp_path, monkeypatch):
    """回归：先保存设置（改语言），再开关插件，语言不能被启动快照覆盖。"""
    api, manager = make_api(tmp_path, monkeypatch)

    s = api.get_settings()
    s["general"]["language"] = "en"
    api.save_settings(s)

    api.set_plugin_enabled("example_theme", True)

    on_disk = config_mod.load_settings()
    assert on_disk["general"]["language"] == "en"
    assert "example_theme" in on_disk["plugins"]["enabled"]
