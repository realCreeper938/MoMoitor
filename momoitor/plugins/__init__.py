"""插件系统 —— 扫描 ./plugins 目录、加载并管理插件。

对外入口:
    get_manager()      获取全局 PluginManager（懒创建 + 扫描 + 激活）
    init_manager()     显式初始化（main.py 在读取设置后调用）
    shutdown_manager() 程序退出前调用，触发插件的 shutdown 钩子
    PluginContext      插件在 register(ctx) 中使用的上下文
    PluginMonitor      数据源插件需继承的监视器基类

示例（在 ./plugins/<name>/config.py 与 __init__.py 中）:

    # config.py
    NAME = "My Plugin"
    VERSION = "1.0.0"
    AUTHOR = "you"
    DESCRIPTION = "..."

    # __init__.py
    def register(ctx):
        ctx.on_snapshot(lambda data: data.update(my=data) or data)
        ctx.add_api_method("my_hello", lambda: "hi")

详见 docs/plugins.md。
"""

from momoitor.config import load_settings

from .base import PluginContext, PluginError, PluginInfo
from .manager import PluginManager
from .monitor import PluginMonitor

__all__ = [
    "PluginManager",
    "PluginContext",
    "PluginInfo",
    "PluginError",
    "PluginMonitor",
    "get_manager",
    "init_manager",
    "shutdown_manager",
]

_manager = None


def get_manager() -> PluginManager:
    """获取全局唯一的 PluginManager（首次调用时自动扫描并激活）。"""
    global _manager
    if _manager is None:
        _manager = PluginManager(load_settings())
        _manager.scan()
        _manager.activate()
    return _manager


def init_manager(settings=None) -> PluginManager:
    """显式初始化插件管理器。

    main.py 在读取设置后、创建硬件监视器前调用，
    以便 create_monitor 能优先使用插件提供的数据源。
    """
    global _manager
    s = settings if settings is not None else load_settings()
    if _manager is None:
        _manager = PluginManager(s)
        _manager.scan()
        _manager.activate()
    else:
        _manager._settings = s
    return _manager


def shutdown_manager():
    """触发所有已启用插件的 shutdown 钩子。幂等。"""
    global _manager
    if _manager is not None:
        _manager.run_shutdown_hooks()
