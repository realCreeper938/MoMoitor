"""Material You 动态配色：系统壁纸或预置种子色生成主题角色。"""

import os
import sys
from functools import lru_cache

from loguru import logger

PRESET_COLORS = {
    "blue": "#4969a8",
    "gray": "#777777",
    "red": "#a94b52",
    "purple": "#76558f",
    "brown": "#876044",
    "green": "#527a55",
    "yellow": "#a17a35",
}

_ROLE_MAP = {
    "bg": "surface_container_low",
    "surface": "surface_container",
    "border": "outline_variant",
    "text": "on_surface",
    "text_dim": "on_surface_variant",
    "accent": "primary",
    "green": "tertiary",
    "yellow": "tertiary",
    "red": "error",
    "cyan": "secondary",
    "blue": "primary",
    "orange": "tertiary",
    "magenta": "tertiary",
    "metric_contrast": "on_surface",
    "metric_cpu": "primary",
    "metric_gpu": "secondary",
    "metric_mem": "tertiary",
    "metric_fps": "primary",
}


def get_system_wallpaper() -> str:
    """读取当前 Windows 桌面壁纸路径，不复制或修改原文件。"""
    if sys.platform != "win32":
        return ""
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Control Panel\Desktop") as key:
            path, _ = winreg.QueryValueEx(key, "Wallpaper")
        return path if isinstance(path, str) and os.path.isfile(path) else ""
    except (OSError, ImportError) as exc:
        logger.debug("Cannot read system wallpaper: {}", exc)
        return ""


def _wallpaper_seed() -> str:
    path = get_system_wallpaper()
    if not path:
        return ""
    try:
        from PIL import Image
        from material_color_utilities import prominent_colors_from_image

        with Image.open(path) as image:
            colors = prominent_colors_from_image(image, 1)
        return colors[0] if colors else ""
    except Exception as exc:
        logger.warning("Cannot extract Material You color from wallpaper: {}", exc)
        return ""


@lru_cache(maxsize=32)
def _theme(source_color: str) -> dict:
    from material_color_utilities import Variant, theme_from_color

    theme = theme_from_color(source_color, 0.0, Variant.TONALSPOT)
    return {"light": theme.schemes.light.dict(), "dark": theme.schemes.dark.dict(), "source": theme.source}


def get_theme(source: str = "blue", mode: str = "dark") -> dict:
    """返回前端所需的 Material You CSS 角色色。"""
    seed = _wallpaper_seed() if source == "wallpaper" else PRESET_COLORS.get(source, PRESET_COLORS["blue"])
    if not seed:
        source = "blue"
        seed = PRESET_COLORS[source]
    scheme = _theme(seed)["light" if mode == "light" else "dark"]
    colors = {name: scheme[role] for name, role in _ROLE_MAP.items()}
    colors["bg_rgb"] = ", ".join(str(int(scheme["surface_container_low"][i:i + 2], 16)) for i in (1, 3, 5))
    return {"source": source, "seed": seed, "mode": mode, "colors": colors}
