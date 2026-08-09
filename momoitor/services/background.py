"""背景图片管理：内置/用户壁纸枚举、虚拟路径解析、保存删除与顶部颜色提取。"""

import os
import base64

from loguru import logger

from momoitor.config import WEB_DIR, WALLPAPERS_DIR

# 允许的图片扩展名
_IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp')


def _ensure_wallpapers_dir():
    try:
        os.makedirs(WALLPAPERS_DIR, exist_ok=True)
    except Exception as e:
        logger.warning("Cannot create wallpapers dir: {}", e)


def _to_fs_path(vpath: str) -> str:
    """把虚拟路径（bg/xxx 或 wp/xxx）映射为磁盘真实路径。

    - bg/  → 打包内置的 momoitor/web/bg/
    - wp/  → 用户数据目录 wallpapers/（由 /wp/ 路由对外提供）
    """
    if vpath.startswith("bg/"):
        return os.path.join(WEB_DIR, vpath)
    if vpath.startswith("wp/"):
        return os.path.join(WALLPAPERS_DIR, vpath[3:])
    return ""


def get_bg_list() -> list:
    """列出可用背景：内置 web/bg/* 与用户 wallpapers/*（带前缀区分）。

    返回条目形如 'bg/xxx.png' 或 'wp/xxx.png'，前端选择器直接用作虚拟路径。
    """
    result = []
    bg_dir = os.path.join(WEB_DIR, "bg")
    if os.path.isdir(bg_dir):
        for f in os.listdir(bg_dir):
            if f.lower().endswith(_IMAGE_EXTS):
                result.append(f"bg/{f}")
    _ensure_wallpapers_dir()
    if os.path.isdir(WALLPAPERS_DIR):
        for f in os.listdir(WALLPAPERS_DIR):
            if f.lower().endswith(_IMAGE_EXTS):
                if f.startswith("_system"):  # 历史遗留的系统壁纸副本不再提供
                    continue
                result.append(f"wp/{f}")
    return result


def resolve_background(image: str) -> str:
    """将背景设置值解析为浏览器可加载的虚拟路径（bg/ 或 wp/）。"""
    if isinstance(image, str) and (image.startswith("bg/") or image.startswith("wp/")):
        if os.path.exists(_to_fs_path(image)):
            return image
    return ""


def save_wallpaper(filename: str = "", data_url: str = "") -> str:
    """保存前端导入的壁纸（base64 data URL），写入用户壁纸目录，返回 wp/ 路径。"""
    if not filename or not data_url or not data_url.startswith("data:"):
        return ""
    try:
        header, _, b64 = data_url.partition(",")
        if "base64" not in header:
            return ""
        ext = os.path.splitext(filename)[1].lower()
        if ext not in _IMAGE_EXTS:
            ext = ".png"
        raw = base64.b64decode(b64)
        if not raw:
            return ""
        _ensure_wallpapers_dir()
        safe_name = os.path.basename(filename)          # 防路径穿越
        name = os.path.splitext(safe_name)[0] + ext
        dest = os.path.join(WALLPAPERS_DIR, name)
        base = os.path.splitext(name)[0]
        counter = 1
        while os.path.exists(dest):                     # 重名自动加序号
            dest = os.path.join(WALLPAPERS_DIR, f"{base}_{counter}{ext}")
            counter += 1
        with open(dest, "wb") as f:
            f.write(raw)
        logger.info("Wallpaper saved: {}", dest)
        return "wp/" + os.path.basename(dest)
    except Exception as e:
        logger.error("save_wallpaper failed: {}", e)
        return ""


def delete_wallpaper(vpath: str = "") -> bool:
    """删除一张用户壁纸。仅允许 wp/ 下的文件，且不能删除历史遗留的系统壁纸副本(_system*)。

    返回是否成功删除。内置壁纸(bg/)与特殊项不允许删除。
    """
    if not isinstance(vpath, str) or not vpath.startswith("wp/"):
        return False
    name = os.path.basename(vpath[3:])          # 取文件名防路径穿越
    if not name or name.startswith("_system"):
        return False
    if not name.lower().endswith(_IMAGE_EXTS):
        return False
    dest = os.path.join(WALLPAPERS_DIR, name)
    try:
        os.remove(dest)
        logger.info("Wallpaper deleted: {}", dest)
        return True
    except FileNotFoundError:
        return False
    except Exception as e:
        logger.error("delete_wallpaper failed: {}", e)
        return False


def get_image_top_color(image: str) -> str:
    """获取背景图片顶部边缘的平均颜色。

    用于在横版时钟栏背景图片高度不足时，生成与图片顶部颜色无缝衔接的渐变填充。
    返回形如 '#rrggbb' 的十六进制颜色字符串；不可用时返回空字符串。
    """
    resolved = resolve_background(image)
    if not resolved:
        return ""
    img_path = _to_fs_path(resolved)
    if not img_path or not os.path.exists(img_path):
        return ""
    try:
        from PIL import Image
        img = Image.open(img_path).convert("RGB")
        # 缩放到较小的宽度并保持宽高比，再对顶部若干行采样
        target_width = 32
        ratio = target_width / img.width
        target_height = max(1, int(img.height * ratio))
        img = img.resize((target_width, target_height), Image.LANCZOS)
        # 对顶部 3 行求平均（图片很矮时则更少）
        sample_rows = min(3, target_height)
        pixels = list(img.crop((0, 0, target_width, sample_rows)).getdata())
        if not pixels:
            return ""
        r = sum(p[0] for p in pixels) // len(pixels)
        g = sum(p[1] for p in pixels) // len(pixels)
        b = sum(p[2] for p in pixels) // len(pixels)
        return "#{:02x}{:02x}{:02x}".format(r, g, b)
    except Exception as e:
        logger.warning("get_image_top_color failed: {}", e)
        return ""
