"""应用程序设置管理。

主要方法:
- load_settings(): 从 data/settings.json 加载设置，返回设置字典
- save_settings(settings): 将设置保存到 data/settings.json 文件
- has_weather_creds(s): 检查设置中是否包含天气 API 凭证

主要变量:
- PROJECT_ROOT: 项目根目录
- DATA_DIR: 用户数据目录 (data/)
- SETTINGS_FILE: 设置文件路径 (data/settings.json)
- DEFAULT_SETTINGS: 默认设置字典，包含所有配置项的默认值
- APP_VERSION: 程序版本号（关于页显示）
"""

import json
import mimetypes
import os
import sys
import copy
import shutil
from loguru import logger

# 为本地静态文件服务注册字体 MIME 类型（Windows mimetypes 缺失），
# 保证 bottle static_file 以正确的 content-type 提供 web 字体。
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("font/otf", ".otf")

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

APP_VERSION = "0.6.0"

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


DEFAULT_SETTINGS = {
    "language": detect_system_language(),
    "refresh_interval": 1000,
    "padding": 60,
    "font_size": 100,
    "fullscreen": False,
    "show_hw_names": False,
    "monitor": 0,
    "gpu_index": 0,
    "hide_when_monitor_missing": False,
    "colorscheme": "gruvbox",
    "hover_highlight": True,  # 鼠标悬停监控项时高亮该项、其余降低透明度
    "hover_animation": True,  # 鼠标悬停卡片时的边框高亮动画
    "clock_24h": True,  # 时钟默认 24 小时制，可在设置中切换为 12 小时制
    "clock_show_seconds": True,  # 时钟是否显示秒
    "weather_lat": "39.92",
    "weather_lon": "116.41",
    "weather_key_id": "",
    "weather_project_id": "",
    "weather_private_key": "",
    "data_source": "lhm",
    "autostart": False,
    "clock_bg_image": "",
    "clock_bg_opacity": 80,
    "clock_bg_blur": 0,
    "clock_bg_gradient": True,
    "clock_bg_fit": "fit",
    "clock_bg_offset_x": 50,
    "clock_bg_offset_y": 50,
    "font_ui": "JetBrains Maple Mono",
    "font_data": "IoskeleyMono",
    "font_clock": "Departure Mono",
    # 布局：各监控卡片在网格中的位置（col 列 / row 行 / span 行跨度 / hidden 是否隐藏）。
    # span=2 为大卡片（CPU/GPU 风格），span=1 为小卡片（内存风格）。CPU/GPU 固定大卡片。
    "layout": {
        "cpu-section": {"col": 2, "row": 2, "span": 2, "hidden": False},
        "gpu-section": {"col": 3, "row": 2, "span": 2, "hidden": False},
        "mem-section": {"col": 2, "row": 4, "span": 1, "hidden": False},
        "disk-section": {"col": 3, "row": 1, "span": 1, "hidden": False},
        "net-section": {"col": 2, "row": 1, "span": 1, "hidden": False},
        "fps-section": {"col": 3, "row": 4, "span": 1, "hidden": False},
        "proc-section": {"col": 3, "row": 5, "span": 1, "hidden": False},
        "music-section": {"col": 2, "row": 5, "span": 1, "hidden": False},
    },
    # 自定义文本卡片：key 为卡片 id，包含内容与样式（字体名/加粗/斜体/字号/对齐/颜色/背景渐变）
    "custom_text": {
        "text-section": {
            "text": "",
            "font": "",
            "bold": False,
            "italic": False,
            "size": 18,
            "align": "left",
            "color": "",
            "bg_grad": False,
            "bg_grad_c1": "",
            "bg_grad_c2": "",
            "bg_grad_size": 100,
        },
    },
    "feature_toggles": {
        "calendar": True,
        "weather": True,  # 是否在时钟侧栏显示天气（即使未配置天气 API 也可开启）
        "top_process": True,
        "sysinfo": True,
        "traffic": True,
        "clock_bg": True,
        "top_control": True,  # 鼠标移到界面顶端时的亮度/音量调节条
    },
    "server_mode": False,
    "server_host": "0.0.0.0",
    "server_port": 20622,
    "server_auth_enabled": False,
    "server_auth_user": "",
    "server_auth_pass": "",
    "hint_dismissed": False,   # 首次启动提示是否已忽略
    "update_check_enabled": True,  # 是否检查 GitHub 新版本并弹窗提示
    "meting_api_base": "",  # 音乐歌词 Meting API 地址，留空关闭歌词
    "lyrics_process_whitelist": "cloudmusic,foobar2000,potplayer,QQMusic",  # 仅这些进程播放媒体时获取歌词，逗号分隔，留空则不限
    "lyrics_auto_translate": False,  # 自动检测歌词行末尾括号内的翻译（原文在下，翻译在上）
    "debug_logs": False,  # 是否输出 debug 级别日志（设置 → 高级 可开启），默认关闭
    "debug": False,  # 是否启用 pywebview 调试模式（F12 打开 DevTools，设置 → 高级 可开关），默认关闭
    "auto_launch_music_player": False,  # 未播放时点击播放按钮自动启动上次播放音乐的进程
}


# load_settings 结果缓存：启动时 main / create_monitor / Api 会多次调用，
# 磁盘 IO 对启动速度有影响，缓存可避免重复读取。save_settings 会同步更新缓存。
_settings_cache = None


def load_settings() -> dict:
    global _settings_cache
    if _settings_cache is not None:
        return copy.deepcopy(_settings_cache)
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                s = json.load(f)

            # 用默认值补充缺失键
            for k, v in DEFAULT_SETTINGS.items():
                if k not in s:
                    s[k] = copy.deepcopy(v)

            _settings_cache = copy.deepcopy(s)
            return s
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("Settings file corrupt, using defaults: {}", e)
    else:
        logger.warning("Settings file not found: {}", SETTINGS_FILE)
    _settings_cache = copy.deepcopy(DEFAULT_SETTINGS)
    return copy.deepcopy(DEFAULT_SETTINGS)


def save_settings(settings: dict):
    global _settings_cache
    _settings_cache = copy.deepcopy(settings)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)


def has_weather_creds(s: dict) -> bool:
    return all(s.get(k) for k in ("weather_key_id", "weather_project_id", "weather_private_key"))
