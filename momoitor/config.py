"""应用程序设置管理：加载/保存 schema 版本化的 settings.json，并提供路径与版本常量。

设置按功能分组（general/display/clock/fonts/weather/music/lyrics/server/layout/
custom_cards/feature_toggles）；旧版扁平结构会在加载时自动检测并迁移回写。
"""

import json
import mimetypes
import os
import sys
import copy
import shutil
from loguru import logger

# 为本地静态文件服务注册 Windows mimetypes 缺失的类型，
# 保证 bottle static_file / server.py 以正确的 content-type 提供资源。
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("font/otf", ".otf")
mimetypes.add_type("image/webp", ".webp")

_FROZEN = getattr(sys, "frozen", False)

if _FROZEN:
    BASE_DIR = sys._MEIPASS
    PROJECT_ROOT = os.path.dirname(sys.executable)  # dist 目录
    _data_root = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    _LEGACY_DATA_DIR = os.path.join(_data_root, "MoMoitor")  # 旧版数据目录（appdata）
    DATA_DIR = PROJECT_ROOT  # 打包版：用户数据存放到程序运行目录
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))  # momoitor/
    PROJECT_ROOT = os.path.dirname(BASE_DIR)  # 仓库根目录
    _LEGACY_DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "MoMoitor")
    DATA_DIR = os.path.join(PROJECT_ROOT, "data")

WEB_DIR = os.path.join(BASE_DIR, "web")
LIB_DIR = os.path.join(BASE_DIR, "libs")

WALLPAPERS_DIR = os.path.join(DATA_DIR, "wallpapers")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")


def _migrate_legacy_data():
    """打包版首次运行时，将旧版 %LOCALAPPDATA%\\MoMoitor 中的数据迁移到新数据目录。

    仅当新数据目录尚不存在设置文件时执行；以拷贝方式迁移（不删除旧数据，
    避免迁移失败导致数据丢失），迁移完成后旧目录保留。
    """
    if not _FROZEN:
        return
    if os.path.abspath(_LEGACY_DATA_DIR) == os.path.abspath(DATA_DIR):
        return
    if not os.path.isdir(_LEGACY_DATA_DIR):
        return
    if os.path.exists(SETTINGS_FILE):  # 已迁移过（新目录已有数据）
        return
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        migrated = 0
        for name in os.listdir(_LEGACY_DATA_DIR):
            src = os.path.join(_LEGACY_DATA_DIR, name)
            dst = os.path.join(DATA_DIR, name)
            if os.path.exists(dst):
                continue
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
            migrated += 1
        if migrated:
            logger.info(
                "Migrated {} item(s) from legacy data dir {} to {}",
                migrated, _LEGACY_DATA_DIR, DATA_DIR,
            )
    except Exception as e:
        logger.warning("Legacy data migration failed: {}", e)


_migrate_legacy_data()

APP_VERSION = "1.1.1"

APP_AUTHOR = "realCreeper938"
APP_HOMEPAGE = "https://github.com/realCreeper938/MoMoitor"
APP_GITHUB_REPO = "realCreeper938/MoMoitor"


def detect_system_language() -> str:
    """根据用户系统语言返回默认语言（"zh" 或 "en"）。

    优先用 Windows UI 语言（GetUserDefaultUILanguage），主语言 ID 0x04=中文；
    非 Windows 或失败时退回 locale。仅用于首次运行等「未显式选择语言」的默认值。
    """
    try:
        import ctypes
        lang = ctypes.windll.kernel32.GetUserDefaultUILanguage()
        if lang & 0xFF == 0x04:          # 主语言 ID：中文
            return "zh"
    except Exception:
        pass
    try:
        import locale
        loc = locale.getdefaultlocale()[0] or ""
        if loc.lower().startswith("zh"):
            return "zh"
    except Exception:
        pass
    return "en"


SCHEMA_VERSION = 2  # 设置结构版本：1=旧版扁平键，2=按功能分组

# 旧版扁平键 → 新版 (分组, 键) 的迁移映射。
_LEGACY_KEY_MAP = {
    # general
    "language": ("general", "language"),
    "refresh_interval": ("general", "refresh_interval"),
    "font_size": ("general", "font_size"),
    "fullscreen": ("general", "fullscreen"),
    "colorscheme": ("general", "colorscheme"),
    "data_source": ("general", "data_source"),
    "autostart": ("general", "autostart"),
    "hover_highlight": ("general", "hover_highlight"),
    "hover_animation": ("general", "hover_animation"),
    "hint_dismissed": ("general", "hint_dismissed"),
    "update_check_enabled": ("general", "update_check_enabled"),
    "debug_logs": ("general", "debug_logs"),
    "debug": ("general", "debug"),
    # display
    "monitor": ("display", "monitor"),
    "gpu_index": ("display", "gpu_index"),
    "hide_when_monitor_missing": ("display", "hide_when_monitor_missing"),
    "show_hw_names": ("display", "show_hw_names"),
    # clock
    "clock_24h": ("clock", "clock_24h"),
    "clock_show_seconds": ("clock", "clock_show_seconds"),
    "clock_bg_image": ("clock", "bg_image"),
    "clock_bg_opacity": ("clock", "bg_opacity"),
    "clock_bg_blur": ("clock", "bg_blur"),
    "clock_bg_gradient": ("clock", "bg_gradient"),
    "clock_bg_fit": ("clock", "bg_fit"),
    "clock_bg_offset_x": ("clock", "bg_offset_x"),
    "clock_bg_offset_y": ("clock", "bg_offset_y"),
    # fonts
    "font_ui": ("fonts", "ui"),
    "font_data": ("fonts", "data"),
    "font_clock": ("fonts", "clock"),
    # weather
    "weather_lat": ("weather", "lat"),
    "weather_lon": ("weather", "lon"),
    "weather_key_id": ("weather", "key_id"),
    "weather_project_id": ("weather", "project_id"),
    "weather_private_key": ("weather", "private_key"),
    # music / lyrics
    "meting_api_base": ("music", "meting_api_base"),
    "auto_launch_music_player": ("music", "auto_launch_music_player"),
    "lyrics_process_whitelist": ("lyrics", "process_whitelist"),
    "lyrics_auto_translate": ("lyrics", "auto_translate"),
    "lyric_animation": ("lyrics", "animation"),
    # server
    "server_mode": ("server", "mode"),
    "server_host": ("server", "host"),
    "server_port": ("server", "port"),
    "server_auth_enabled": ("server", "auth_enabled"),
    "server_auth_user": ("server", "auth_user"),
    "server_auth_pass": ("server", "auth_pass"),
}

# 本身就是完整字典、整体替换的分组键（迁移/合并时按整体处理）
_WHOLE_GROUPS = ("layout", "custom_cards", "feature_toggles")

DEFAULT_SETTINGS = {
    "schema_version": SCHEMA_VERSION,
    # 通用：语言 / 刷新频率 / 界面字号 / 全屏 / 主题 / 数据源 / 自启动 / 悬停特效等
    "general": {
        "language": detect_system_language(),
        "refresh_interval": 1000,
        "font_size": 100,  # 卡片字体大小（含悬浮窗）
        "font_size_ui": 100,  # 界面字体大小（设置/弹窗等）
        "fullscreen": False,
        "window_opacity": 100,  # 原生窗口透明度（百分比）
        "colorscheme": "gruvbox",
        "colorscheme_dark": "gruvbox",  # 跟随系统主题时使用的暗色主题
        "colorscheme_light": "gruvbox-light",  # 跟随系统主题时使用的亮色主题
        "follow_system_theme": False,  # 是否跟随 Windows 亮/暗模式自动切换主题
        "data_source": "lhm",  # 兼容旧版单数据源设置（迁移为 data_sources 首项）
        "data_sources": [  # 数据源优先级列表：数组顺序即优先级，enabled 控制是否启用；默认仅启用 lhm
            {"source": "lhm", "enabled": True},
            {"source": "aida64", "enabled": False},
            {"source": "hwinfo", "enabled": False},
            {"source": "wmi", "enabled": False},
        ],
        "autostart": False,
        "hover_highlight": True,  # 鼠标悬停监控项时高亮该项、其余降低透明度
        "hover_animation": True,  # 鼠标悬停卡片时的边框高亮动画
        "settings_blur": True,  # 设置页面背景模糊
        "settings_shadow": True,  # 设置面板阴影
        "settings_animation": True,  # 设置界面动画（标签/面板过渡）
        "card_gradient": True,  # 音乐/天气卡片的背景渐变效果
        "bg_charts": True,  # 卡片背景折线图（CPU/GPU/内存/网络/磁盘/FPS 与天气降水趋势）；自定义数据卡片由自身开关控制
        "game_mode": True,  # 自动游戏模式：GPU 占用持续 6 秒超过 60% 时降低刷新频率并关闭非交互动画
        "hint_dismissed": False,   # 首次启动提示是否已忽略
        "force_welcome": False,  # 下次启动时是否强制显示欢迎向导
        "update_check_enabled": True,  # 是否检查 GitHub 新版本并弹窗提示
        "debug_logs": False,  # 是否输出 debug 级别日志（设置 → 高级 可开启），默认关闭
        "debug": False,  # 是否启用 pywebview 调试模式（F12 打开 DevTools），默认关闭
        "debug_clock_gradient": "",  # 调试：强制时钟渐变显示为某时段，空串为按当前时间自动
    },
    # 显示/监视器
    "display": {
        "monitor": 0,
        "monitor_id": "",  # 指定显示器的稳定设备 ID（优先于 monitor 序号），空则回退 monitor
        "gpu_index": 0,
        "hide_when_monitor_missing": False,
        "show_hw_names": False,
        "on_top": True,  # 窗口是否始终置顶
    },
    # 时钟（含背景）
    "clock": {
        "clock_24h": True,  # 时钟默认 24 小时制，可在设置中切换为 12 小时制
        "clock_show_seconds": True,  # 时钟是否显示秒
        "bg_image": "",
        "bg_opacity": 80,
        "bg_blur": 0,
        "bg_gradient": True,
        "bg_fit": "fit",
        "bg_offset_x": 50,
        "bg_offset_y": 50,
    },
    # 字体
    "fonts": {
        "ui": "JetBrains Maple Mono",
        "data": "IoskeleyMono",
        "clock": "Departure Mono",
    },
    # 天气
    "weather": {
        "enabled": True,  # 是否启用天气：关闭后不再获取任何天气信息
        "source": "qweather",  # 数据源：qweather / openweathermap / open-meteo
        "lat": "39.92",
        "lon": "116.41",
        "key_id": "",
        "project_id": "",
        "private_key": "",
        "appid": "",  # OpenWeatherMap AppID（仅 openweathermap 数据源使用）
    },
    # 音乐 / 歌词
    "music": {
        "meting_api_base": "",  # 音乐歌词 Meting API 地址，留空关闭歌词
        "auto_launch_music_player": False,  # 未播放时点击播放按钮自动启动上次播放音乐的进程
        "spectrum": False,  # 音乐卡片频谱可视化（WASAPI 回环捕获，仅媒体播放时运行）
        "spectrum_position": "bottom",  # 频谱位置：bottom / top / left / right
        "spectrum_style": "bars",  # 频谱样式：bars 柱状 / wave 平滑渐变波形
        "spectrum_color": "gradient",  # 频谱颜色：gradient 多彩渐变 / theme 跟随配色 / cover 封面取色
        "spectrum_smooth": 65,  # 频谱平滑度百分比（0 ~ 100）越高柱值变化越柔缓
        "spectrum_sensitivity": 100,  # 频谱敏感度（50 ~ 200）越低需越大音量才有明显波形，越高越早满格
        "spectrum_bars": 28,  # 频谱柱数量（12 ~ 48），越多越密集
    },
    "lyrics": {
        "source": "meting",  # 歌词数据源：meting（Meting API）/ lrcapi（LrcApi）
        "process_whitelist": "cloudmusic,foobar2000,potplayer,QQMusic",  # 仅这些进程播放媒体时获取歌词，逗号分隔，留空则不限
        "auto_translate": False,  # 自动检测歌词行末尾括号内的翻译（原文在下，翻译在上）
        "animation": False,  # 歌词滚动动画
        "switch_animation": True,  # 歌词换句平滑滚动动画（下一句滚动进当前行位置，关闭则直接跳变）
        "estimated_position": False,  # 歌词预测：播放器不汇报进度时按已播放时长估算推进（暂停即停）
        "time_offset": 0,  # 歌词时间偏移秒数（正=歌词提前显示），范围 -10 ~ +10
        "lrcapi_base": "",  # LrcApi 歌词地址，留空使用官方公开 API（https://api.lrc.cx/lyrics）
    },
    # 心率：BLE 设备地址/名称，animation 为心图标随心率跳动动画
    "hr": {
        "device_address": "",
        "device_name": "",
        "animation": False,
    },
    # 服务端模式
    "server": {
        "mode": False,
        "host": "0.0.0.0",
        "port": 20622,
        "auth_enabled": False,
        "auth_user": "",
        "auth_pass": "",
    },
    # 布局：各监控卡片在网格中的位置（col 列 / row 行 / span 行跨度 / hidden 是否隐藏）。
    # font_scale 为该卡片独立的字体缩放百分比（相对全局字体大小，50–200，100 为默认）。
    # span=2 为大卡片（CPU/GPU 风格），span=1 为小卡片（内存风格）。CPU/GPU 固定大卡片。
    "layout": {
        # 网格行列数：rows/cols 为卡片区域的网格尺寸（时钟始终占一列），
        # 布局编辑器里可以随时调整；缺失时前端回退到 5 行 2 列。
        "rows": 5,
        "cols": 2,
        "cpu-section": {"col": 2, "row": 1, "span": 2, "hidden": False, "font_scale": 100},
        "gpu-section": {"col": 3, "row": 1, "span": 2, "hidden": False, "font_scale": 100},
        "mem-section": {"col": 2, "row": 4, "span": 1, "hidden": False, "font_scale": 100},
        "disk-section": {"col": 3, "row": 3, "span": 1, "hidden": False, "font_scale": 100},
        "net-section": {"col": 2, "row": 3, "span": 1, "hidden": False, "font_scale": 100},
        "fps-section": {"col": 3, "row": 4, "span": 2, "hidden": False, "font_scale": 100},
        "proc-section": {"col": 3, "row": 5, "span": 1, "hidden": True, "font_scale": 100},
        "music-section": {"col": 2, "row": 5, "span": 1, "hidden": False, "font_scale": 100},
        "hr-section": {"col": 2, "row": 6, "span": 1, "hidden": True, "font_scale": 100},
    },
    # 自定义卡片：key 为卡片 id，type 区分类型（text 文本 / html 自定义 HTML）。
    # text 含内容与样式（字体名/加粗/斜体/字号/对齐/颜色）；html 含 html 字段。
    # 旧版本（custom_text 分组）写入的条目启动时统一迁移。
    "custom_cards": {
        "text-section": {
            "type": "text",
            "text": "",
            "font": "",
            "bold": False,
            "italic": False,
            "size": 18,
            "align": "left",
            "color": "",
        },
    },
    "feature_toggles": {
        "weather": True,  # 是否在时钟侧栏显示天气（仅影响显示，不影响天气卡片与数据获取）
        "traffic": True,
        "clock_bg": True,
        "top_control": True,  # 鼠标移到界面顶端时的亮度/音量调节条
    },
}


def _migrate_data_sources(general: dict, has_sources: bool = False):
    """把 general 分组内的数据源设置规范化。

    兼容旧版单一 data_source 字符串：has_sources 为 False（用户未显式提供
    data_sources 列表，即旧版升级）时，以 data_source 值为首项生成完整列表。
    若用户已提供 data_sources，则确保兼容键 data_source 指向当前首个启用源，
    避免前端旧逻辑误读。
    """
    if not has_sources:
        legacy = general.get("data_source") or "lhm"
        default_enabled = {
            d["source"]: d.get("enabled", True)
            for d in DEFAULT_SETTINGS["general"]["data_sources"]
        }
        order = [legacy] + [
            d["source"] for d in DEFAULT_SETTINGS["general"]["data_sources"]
            if d["source"] != legacy
        ]
        general["data_sources"] = [
            {"source": s, "enabled": (s == legacy) or bool(default_enabled.get(s))}
            for s in order
        ]
    else:
        # 已有 data_sources 列表：按默认顺序补全缺失的后端（保持用户已有顺序与启用状态），
        # 确保列表始终包含全部可用后端，避免前端漏显示。
        sources = general.get("data_sources")
        if isinstance(sources, list) and sources and isinstance(sources[0], dict):
            default_enabled = {
                d["source"]: d.get("enabled", True)
                for d in DEFAULT_SETTINGS["general"]["data_sources"]
            }
            seen = {item["source"] for item in sources if isinstance(item, dict)}
            merged = [dict(item) for item in sources if isinstance(item, dict)]
            for d in DEFAULT_SETTINGS["general"]["data_sources"]:
                if d["source"] not in seen:
                    merged.append({"source": d["source"], "enabled": bool(d.get("enabled", True))})
            general["data_sources"] = merged
            general["data_source"] = merged[0]["source"] if merged[0].get("enabled") else "lhm"


def _looks_legacy(raw: dict) -> bool:
    """判断是否为旧版扁平结构，需要迁移。

    schema_version 为 SCHEMA_VERSION 是"新版"的强信号；否则若存在任何
    旧版扁平键（layout/custom_cards/feature_toggles 与新版组名重合，
    不能作为判定依据），则为旧版需要迁移。load_settings 用同一判定
    决定是否回写，两处逻辑必须保持一致。
    """
    return raw.get("schema_version") != SCHEMA_VERSION and any(
        k in raw for k in _LEGACY_KEY_MAP
    )


def _normalize_settings(raw: dict) -> dict:
    """将任意旧版/缺键设置字典统一为新版分组结构。

    迁移旧版扁平键到分组；用 DEFAULT_SETTINGS 补充缺失的组与组内键。
    已是新版结构时仅补默认值。返回新字典（不修改入参）。
    """
    if not isinstance(raw, dict):
        return copy.deepcopy(DEFAULT_SETTINGS)

    is_old = _looks_legacy(raw)

    # 自定义卡片分组更名迁移：旧版使用 custom_text 分组，统一迁移为 custom_cards。
    if "custom_cards" not in raw and isinstance(raw.get("custom_text"), dict):
        raw = dict(raw)
        raw["custom_cards"] = raw.pop("custom_text")

    new = {}
    if not is_old:
        # 新版结构（或仅缺键）：整体沿用，只补默认值
        for group, defaults in DEFAULT_SETTINGS.items():
            if group == "schema_version":
                continue
            value = raw.get(group, defaults)
            if isinstance(defaults, dict) and isinstance(value, dict):
                if group in _WHOLE_GROUPS:
                    merged = copy.deepcopy(value)
                else:
                    merged = dict(defaults)
                    merged.update(value)
                    if group == "general":
                        _migrate_data_sources(merged, has_sources=isinstance(value, dict) and "data_sources" in value)
                    else:
                        # 旧版 bug 曾把 data_sources/data_source 注入每个分组，这里清理掉
                        merged.pop("data_sources", None)
                        merged.pop("data_source", None)
                    if group == "music":
                        # 频谱幅度（spectrum_gain）已由频谱平滑度取代，清理历史残留键
                        merged.pop("spectrum_gain", None)
            else:
                merged = copy.deepcopy(value)
            new[group] = merged
    else:
        # 旧版扁平结构：按映射迁移
        for group, defaults in DEFAULT_SETTINGS.items():
            if group == "schema_version":
                continue
            if group in _WHOLE_GROUPS:
                # layout/custom_cards/feature_toggles 本身就是顶层组，旧版即已存在，原样沿用
                new[group] = copy.deepcopy(raw.get(group, defaults))
            elif isinstance(defaults, dict):
                merged = dict(defaults)
                for flat_key, (g, key) in _LEGACY_KEY_MAP.items():
                    if g == group and flat_key in raw:
                        merged[key] = raw[flat_key]
                if group == "general":
                    _migrate_data_sources(merged)
                new[group] = merged
            else:
                new[group] = copy.deepcopy(defaults)

    new["schema_version"] = SCHEMA_VERSION

    # 自定义卡片自动迁移：旧版本写入的卡片没有 type 字段，
    # 下次启动时统一补充为 text；已移除的 clock 类型卡片一并清除。
    custom_cards = new.get("custom_cards")
    if isinstance(custom_cards, dict):
        for card_id, entry in list(custom_cards.items()):
            if isinstance(entry, dict):
                if entry.get("type") == "clock":
                    del custom_cards[card_id]
                else:
                    entry.setdefault("type", "text")

    return new


# load_settings 结果缓存：启动时 main / create_monitor / Api 会多次调用，
# 磁盘 IO 对启动速度有影响，缓存可避免重复读取。save_settings 会同步更新缓存。
_settings_cache = None


def server_conf(settings: dict) -> dict:
    """读取 settings["server"] 分组并补齐默认值。

    server 模式相关代码（main / server / api.core）统一经此访问，
    避免默认值（端口 20622 等）多处硬编码漂移。
    """
    conf = dict(DEFAULT_SETTINGS.get("server", {}))
    conf.update(settings.get("server") or {})
    return conf


def load_settings() -> dict:
    global _settings_cache
    if _settings_cache is not None:
        return copy.deepcopy(_settings_cache)
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                raw = json.load(f)
            s = _normalize_settings(raw)
            # 若磁盘上仍是旧版扁平结构，或仍在使用旧版 custom_text 分组名，
            # 回写为新版结构（下次启动即为新版）。判定逻辑与 _normalize_settings 一致。
            if _looks_legacy(raw):
                save_settings(s)
            elif isinstance(raw.get("custom_text"), dict) and "custom_cards" not in raw:
                save_settings(s)
            _settings_cache = copy.deepcopy(s)
            return s
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("Settings file corrupt, using defaults: {}", e)
    else:
        logger.warning("Settings file not found: {}", SETTINGS_FILE)
    _settings_cache = copy.deepcopy(DEFAULT_SETTINGS)
    return copy.deepcopy(_settings_cache)


def save_settings(settings: dict):
    global _settings_cache
    settings = _normalize_settings(settings)
    _settings_cache = copy.deepcopy(settings)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)


def reload_settings() -> dict:
    """丢弃设置缓存并重新从磁盘加载（数据还原等场景使用）。"""
    global _settings_cache
    _settings_cache = None
    return load_settings()


def has_weather_creds(s: dict) -> bool:
    w = s.get("weather", {})
    return all(w.get(k) for k in ("key_id", "project_id", "private_key"))
