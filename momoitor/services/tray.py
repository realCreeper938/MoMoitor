"""系统托盘图标服务（pystray）。

桌面模式：左键单击聚焦主窗口；右键菜单提供显示器选择（与设置双向同步）与退出。
服务端模式：没有桌面窗口，菜单改为显示访问地址与「关闭服务端模式」（持久化
关闭后 HTTP 服务停止、程序随之退出）。

由 main.py 在窗口/HTTP 服务就绪前调用 start(api)；设置保存后经 ApiCore 调用
refresh() 重建菜单；退出路径统一经 stop() 移除图标。
"""

import copy
import os
import threading

from loguru import logger

from momoitor.config import BASE_DIR, PROJECT_ROOT, server_conf
from momoitor.services import window as win_svc

# 托盘菜单文案：前端 i18n 字典无法在 Python 侧复用，此处按 settings.general.language 取词。
_LABELS = {
    "zh": {
        "show": "显示主窗口",
        "display": "显示器",
        "server": "服务器地址",
        "disable_server": "关闭服务端模式",
        "exit": "退出",
    },
    "en": {
        "show": "Show Window",
        "display": "Display",
        "server": "Server Address",
        "disable_server": "Disable Server Mode",
        "exit": "Exit",
    },
}

_icon = None  # pystray.Icon 实例（未启动为 None）
_api = None   # 关联的 Api 实例
_lock = threading.Lock()  # 序列化菜单重建，避免多线程并发 Destroy/Create 菜单


def _labels() -> dict:
    lang = ""
    if _api is not None:
        lang = (_api._settings.get("general", {}) or {}).get("language") or ""
    return _LABELS.get(lang, _LABELS["en"])


def _load_image():
    """加载程序图标作为托盘图像。优先取打包资源与仓库 assets/app.ico，
    都缺失时退回纯色占位图（正常打包一定包含 app.ico，见 MoMoitor.spec datas）。"""
    from PIL import Image
    candidates = [
        os.path.join(BASE_DIR, "assets", "app.ico"),
        os.path.join(PROJECT_ROOT, "assets", "app.ico"),
    ]
    for path in candidates:
        try:
            if os.path.exists(path):
                im = Image.open(path)
                im.load()  # 立即读入并释放文件句柄
                return im
        except Exception as e:
            logger.warning("Failed to load tray icon {}: {}", path, e)
    logger.warning("app.ico not found, using fallback tray image")
    return Image.new("RGBA", (32, 32), (24, 24, 24, 255))


def _monitor_items():
    """显示器单选子菜单项；选中即保存设置并移动窗口（复用 save_settings 流程）。"""
    import pystray

    api = _api
    monitors = win_svc.get_monitors()
    if not monitors:
        return []
    current, _ = win_svc.find_display(
        win_svc.display_target(api._settings.get("display", {})), monitors)
    cur_id = (current or {}).get("id") or ""

    items = []
    for m in monitors:
        mid = m.get("id") or m.get("device") or ""
        label = "%s (%dx%d)%s" % (
            m.get("name") or "Monitor", m["width"], m["height"],
            " *" if m.get("primary") else "")

        # 注意：pystray 按函数位置参数个数校验回调（action 最多 2 个），
        # 不能用带默认值参数绑定循环变量，须以闭包捕获。
        def make_handlers(_mid=mid):
            def on_pick(_icon, _item):
                _select_monitor(_mid)

            def is_checked(_item):
                return _mid == cur_id

            return on_pick, is_checked

        on_pick, is_checked = make_handlers()
        items.append(pystray.MenuItem(label, on_pick, radio=True, checked=is_checked))
    return items


def _build_menu():
    """构建右键菜单。返回 MenuItem 元组（pystray 动态菜单约定）。"""
    import pystray

    text = _labels()
    try:
        api = _api
        has_window = bool(getattr(api, "_window", None)) if api else False
        items = []
        if has_window:
            items.append(pystray.MenuItem(text["show"], _on_show, default=True))
            monitor_items = _monitor_items()
            if monitor_items:
                items.append(pystray.Menu.SEPARATOR)
                items.append(pystray.MenuItem(text["display"], pystray.Menu(*monitor_items)))
        if api and server_conf(api._settings).get("mode", False):
            urls = []
            try:
                urls = api.get_server_info().get("urls", [])
            except Exception as e:
                logger.warning("get_server_info failed: {}", e)
            if urls or getattr(api, "_server_backend", None):
                items.append(pystray.Menu.SEPARATOR)
                items.append(pystray.MenuItem(text["server"], None, enabled=False))
                for url in urls:
                    items.append(pystray.MenuItem(url, None, enabled=False))
                items.append(pystray.MenuItem(text["disable_server"], _on_disable_server))
        items.append(pystray.Menu.SEPARATOR)
        items.append(pystray.MenuItem(text["exit"], _on_exit))
        return tuple(items)
    except Exception:
        logger.exception("Failed to build tray menu")
        return (pystray.MenuItem(text["exit"], _on_exit),)


def _select_monitor(mid):
    """从托盘选择显示器：写入设置并走 save_settings 统一流程（持久化、移动窗口、
    全屏重应用、同步前端缓存、刷新托盘菜单），窗口立即移动。

    必须在副本上修改：save_settings 依靠对比「保存前」的 display 值判定
    monitor_changed 才会立即移窗；若原地改 api._settings，则新旧值相同、
    判定为未变化，窗口要等下次启动才会移动。
    """
    api = _api
    if not api:
        return
    s = copy.deepcopy(api._settings)
    disp = s.setdefault("display", {})
    disp["monitor_id"] = mid
    # 同步 legacy 序号，保持与前端设置面板写入行为一致（settings.js 同时写两者）
    try:
        monitors = win_svc.get_monitors()
        disp["monitor"] = next(
            (i for i, m in enumerate(monitors)
             if (m.get("id") or m.get("device")) == mid), 0)
    except Exception:
        disp["monitor"] = 0
    api.save_settings(s)


def _on_show(_icon, _item):
    """左键单击默认动作：显示并聚焦主窗口。"""
    api = _api
    if api and api._window:
        win_svc.focus(api._window)


def _on_disable_server(_icon, _item):
    """关闭服务端模式：持久化关闭并停止 HTTP 后端。

    服务端模式下程序仅由 HTTP 服务构成，停止后 main 的阻塞调用返回、进程退出；
    下次启动将以桌面模式运行。
    """
    api = _api
    if not api:
        return
    logger.info("Disabling server mode from tray")
    s = api._settings
    s.setdefault("server", {})["mode"] = False
    api.save_settings(s)
    backend = getattr(api, "_server_backend", None)
    if backend:
        backend.stop()


def _on_exit(_icon, _item):
    logger.info("Exit requested from tray")
    api = _api
    stop()
    if api:
        api.close_app()


def start(api):
    """启动托盘图标线程。重复调用无效果；pystray 缺失时降级为仅日志。"""
    global _icon, _api
    if _icon is not None:
        return
    try:
        import pystray
    except ImportError as e:
        logger.warning("pystray unavailable, tray icon disabled: {}", e)
        return
    _api = api
    with _lock:
        _icon = pystray.Icon(
            "MoMoitor", _load_image(), "MoMoitor",
            pystray.Menu(lambda: _build_menu()))
    # setup 回调在托盘消息循环就绪后执行，避免 hwnd 未建立时显示失败
    _icon.run_detached(setup=lambda ic: setattr(ic, "visible", True))
    logger.info("Tray icon started")


def stop():
    """移除托盘图标并结束其线程。幂等；未启动时无效果。"""
    global _icon, _api
    with _lock:
        icon, _icon = _icon, None
    _api = None
    if icon is not None:
        try:
            icon.stop()
            logger.debug("Tray icon stopped")
        except Exception as e:
            logger.debug("Tray stop failed: {}", e)


def refresh():
    """状态变化（设置保存、HTTP 后端启停）后重建菜单。未启动时无效果。"""
    with _lock:
        icon = _icon
    if icon is not None:
        try:
            icon.update_menu()
        except Exception as e:
            logger.debug("Tray refresh failed: {}", e)
