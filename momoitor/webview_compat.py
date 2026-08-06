"""pywebview + bottle 兼容修复。

pywebview 的 BottleServer 用 bottle 服务本地前端文件，注册了
    @app.route('/')
    @app.route('/<file:path>')
    def asset(file):
        return bottle.static_file(file, root=server.root_path)

bottle 0.13+ 对根路径 '/' 不传 file 参数，导致 asset() 缺参抛 TypeError，
本地页面加载返回 500（"asset() missing 1 required positional argument: 'file'"）。
bottle 0.12.x 因使用已移除的 cgi 模块，在 Python 3.13 上无法导入，故不能降级。
这里在启动时包装 Bottle.route，让 asset 在缺 file 时默认服务 index.html。

仅当目标构建用的 pywebview 内仍含名为 asset 的路由处理函数时生效；
若未来 pywebview 改动该实现，本补丁静默失效（不影响启动）。
"""

import os

import bottle

from momoitor.config import WALLPAPERS_DIR

_orig_route = bottle.Bottle.route
_handled_apps = set()


def _register_wallpapers_route(app):
    """给 pywebview 内部 bottle app 挂一条 /wp/ 静态路由，服务用户壁纸目录。"""
    try:
        os.makedirs(WALLPAPERS_DIR, exist_ok=True)
    except Exception:
        pass

    @app.route('/wp/<file:path>')
    def serve_wallpaper(file):
        return bottle.static_file(file, root=WALLPAPERS_DIR)


def _patched_route(self, path=None, method="GET", **kwargs):
    # 每个 Bottle 实例在首次注册路由时附加壁纸路由（此处用 _orig_route 避免递归）
    if id(self) not in _handled_apps:
        _handled_apps.add(id(self))
        _register_wallpapers_route(self)

    def deco(callback):
        if getattr(callback, "__name__", "") == "asset":
            def asset_guard(*args, **kw):
                kw.setdefault("file", "index.html")
                return callback(*args, **kw)
            asset_guard.__name__ = callback.__name__
            return _orig_route(self, path, method, **kwargs)(asset_guard)
        return _orig_route(self, path, method, **kwargs)(callback)
    return deco


bottle.Bottle.route = _patched_route
