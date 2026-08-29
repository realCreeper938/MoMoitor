"""设置文件持久化测试：保存/加载往返、归一化、旧版迁移、数据不丢失。"""

import json
import os

import pytest

import momoitor.config as config_mod
from momoitor.config import _normalize_settings


@pytest.fixture
def isolated_config(tmp_path, monkeypatch):
    """把设置读写重定向到临时目录，避免污染真实 data/settings.json。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config_mod, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config_mod, "WALLPAPERS_DIR", str(tmp_path / "wallpapers"))
    monkeypatch.setattr(config_mod, "_settings_cache", None)
    return config_mod


# ── 归一化 ────────────────────────────────────────────────────


def test_normalize_fills_defaults():
    s = _normalize_settings({})
    assert s["schema_version"] == config_mod.SCHEMA_VERSION
    assert "general" in s and "layout" in s
    assert s["layout"]["rows"] == 5 and s["layout"]["cols"] == 2
    assert s["general"]["language"] in ("zh", "en")


def test_normalize_preserves_existing_values():
    s = _normalize_settings({"general": {"language": "en", "refresh_interval": 2000}})
    assert s["general"]["language"] == "en"
    assert s["general"]["refresh_interval"] == 2000
    # 未提供的键保留默认值
    assert s["general"]["colorscheme"] == "gruvbox"


def test_game_mode_default_and_backfill():
    """游戏模式开关默认开启；旧设置文件缺少该键时归一化自动回填。"""
    assert config_mod.DEFAULT_SETTINGS["general"]["game_mode"] is True
    s = _normalize_settings({"general": {"language": "zh"}})
    assert s["general"]["game_mode"] is True
    s = _normalize_settings({"general": {"game_mode": False}})
    assert s["general"]["game_mode"] is False


def test_normalize_preserves_whole_groups():
    """layout/feature_toggles 是整体分组：内部键缺失时不能被默认值覆盖；
    custom_cards 条目启动时自动补齐 type 字段（旧版条目迁移为 text）。"""
    raw = {
        "layout": {"rows": 8, "cols": 3, "cpu-section": {"col": 2, "row": 1, "span": 2}},
        "custom_cards": {"text-section": {"text": "hello"}},
        "feature_toggles": {"weather": False},
    }
    s = _normalize_settings(raw)
    assert s["layout"] == raw["layout"]
    assert s["feature_toggles"] == raw["feature_toggles"]
    assert s["custom_cards"]["text-section"]["text"] == "hello"
    assert s["custom_cards"]["text-section"]["type"] == "text"


def test_normalize_data_sources_only_in_general():
    """data_sources/data_source 只能出现在 general 分组。

    旧版 bug 曾把 _migrate_data_sources 应用到每个分组，导致 display/clock/...
    都被注入 data_sources/data_source；归一化时应清理掉这些冗余键。
    """
    raw = {
        "display": {"monitor": 1, "data_sources": [{"source": "lhm", "enabled": True}], "data_source": "lhm"},
        "weather": {"lat": "39.9", "lon": "116.4", "data_sources": [{"source": "lhm", "enabled": True}]},
    }
    s = _normalize_settings(raw)
    assert s["general"]["data_sources"]
    assert s["general"]["data_source"] == "lhm"
    for group in ("display", "clock", "fonts", "weather", "music", "lyrics", "server"):
        assert "data_sources" not in s[group]
        assert "data_source" not in s[group]


def test_normalize_custom_cards_preserves_existing_types():
    """已有 type 的自定义卡片条目原样保留，不被迁移改写；clock 类型已移除，被清除。"""
    raw = {
        "custom_cards": {
            "custom-clock-1": {"type": "clock", "timezone": "Asia/Shanghai"},
            "custom-html-1": {"type": "html", "html": "<b>x</b>"},
        }
    }
    s = _normalize_settings(raw)
    assert "custom-clock-1" not in s["custom_cards"]
    assert s["custom_cards"]["custom-html-1"] == {"type": "html", "html": "<b>x</b>"}


def test_normalize_migrates_legacy_custom_text_group():
    """旧版 custom_text 分组启动时自动迁移为 custom_cards，内容原样保留。"""
    raw = {
        "custom_text": {
            "text-section": {"text": "hello", "align": "center"},
            "custom-clock-1": {"type": "clock", "timezone": "UTC"},
        }
    }
    s = _normalize_settings(raw)
    assert "custom_text" not in s
    assert s["custom_cards"]["text-section"]["text"] == "hello"
    assert s["custom_cards"]["text-section"]["align"] == "center"
    assert "custom-clock-1" not in s["custom_cards"]


def test_normalize_legacy_flat_migration():
    """旧版扁平键应迁移到分组结构。"""
    raw = {
        "schema_version": 1,
        "language": "en",
        "refresh_interval": 2000,
        "clock_24h": False,
        "server_mode": True,
        "server_port": 8080,
    }
    s = _normalize_settings(raw)
    assert s["schema_version"] == config_mod.SCHEMA_VERSION
    assert s["general"]["language"] == "en"
    assert s["general"]["refresh_interval"] == 2000
    assert s["clock"]["clock_24h"] is False
    assert s["server"]["mode"] is True
    assert s["server"]["port"] == 8080


def test_normalize_non_dict_returns_defaults():
    assert _normalize_settings(None)["schema_version"] == config_mod.SCHEMA_VERSION
    assert _normalize_settings("junk")["general"]["language"] in ("zh", "en")


# ── 保存 / 加载往返 ───────────────────────────────────────────


def test_save_then_load_roundtrip(isolated_config, monkeypatch):
    s = isolated_config.load_settings()
    s["general"]["language"] = "en"
    s["general"]["refresh_interval"] = 2000
    s["layout"]["rows"] = 8
    s["layout"]["cols"] = 3

    isolated_config.save_settings(s)

    # 强制重新读盘（清缓存），验证写入的内容
    monkeypatch.setattr(config_mod, "_settings_cache", None)
    loaded = isolated_config.load_settings()
    assert loaded["general"]["language"] == "en"
    assert loaded["general"]["refresh_interval"] == 2000
    assert loaded["layout"]["rows"] == 8
    assert loaded["layout"]["cols"] == 3
    assert loaded["schema_version"] == config_mod.SCHEMA_VERSION


def test_save_writes_utf8_json(isolated_config):
    s = isolated_config.load_settings()
    s["general"]["language"] = "zh"
    s["custom_cards"]["text-section"]["text"] = "自定义文本"
    isolated_config.save_settings(s)

    with open(isolated_config.SETTINGS_FILE, "r", encoding="utf-8") as f:
        raw = json.load(f)
    assert raw["custom_cards"]["text-section"]["text"] == "自定义文本"
    assert raw["schema_version"] == config_mod.SCHEMA_VERSION


def test_save_updates_cache(isolated_config):
    s = isolated_config.load_settings()
    s["general"]["language"] = "fr"
    isolated_config.save_settings(s)
    # 不重读盘也应拿到最新值（缓存同步）
    assert isolated_config.load_settings()["general"]["language"] == "fr"


def test_save_preserves_unrelated_groups(isolated_config, monkeypatch):
    """保存时不应丢失任何分组：整份文件往返必须完整。"""
    s = isolated_config.load_settings()
    isolated_config.save_settings(s)

    monkeypatch.setattr(config_mod, "_settings_cache", None)
    loaded = isolated_config.load_settings()
    for group in ("general", "display", "clock", "fonts", "weather", "music",
                  "lyrics", "server", "layout", "custom_cards", "feature_toggles"):
        assert group in loaded


def test_load_missing_file_returns_defaults(isolated_config):
    s = isolated_config.load_settings()
    assert s["schema_version"] == config_mod.SCHEMA_VERSION


def test_load_corrupt_file_returns_defaults(isolated_config):
    with open(isolated_config.SETTINGS_FILE, "w", encoding="utf-8") as f:
        f.write("{ this is not valid json ")
    s = isolated_config.load_settings()
    assert s["schema_version"] == config_mod.SCHEMA_VERSION
    assert s["general"]["language"] in ("zh", "en")


# ── 天气凭据 ──────────────────────────────────────────────────


def test_has_weather_creds():
    from momoitor.config import has_weather_creds

    s = _normalize_settings({})
    assert has_weather_creds(s) is False
    s["weather"].update(key_id="a", project_id="b", private_key="c")
    assert has_weather_creds(s) is True
