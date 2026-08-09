"""示例插件的 Python 端逻辑

插件目录名（example_basic）必须是合法的 Python 标识符，
这样 __init__.py 才能被作为模块导入。

register(ctx) 是插件入口，在启动时被调用。ctx 是 PluginContext，
提供了 get_settings / save_settings / add_api_method / on_snapshot /
on_startup / on_shutdown / on_settings_saved / call_js / emit 等能力。
"""

import time

from loguru import logger

log = logger.bind(plugin="example_basic")


def on_startup():
    """应用启动完成时调用。"""
    log.info("example_basic startup hook")


def on_shutdown():
    """应用退出时调用，可以做清理工作。"""
    log.info("example_basic shutdown hook")


def on_snapshot(data):
    """快照钩子：每次轮询硬件数据后调用。

    钩子可以修改传入的 data 字典（会被合并进前端快照），
    也可以返回一个全新的字典来整体替换快照。
    """
    data["example"] = {"time": time.time()}
    return data


def on_settings_saved(settings):
    """设置保存后调用，settings 是规范化后的完整设置字典。"""
    log.debug("settings saved: language={}", (settings.get("general") or {}).get("language"))


def register(ctx):
    """插件入口。ctx 是 momoitor.plugins.base.PluginContext。"""

    # 注册一个自定义 API 方法：前端可以通过 pywebview.api.example_hello(...) 调用
    def example_hello(name="world"):
        return "Hello, {}! (from {})".format(name, ctx.id)

    ctx.add_api_method("example_hello", example_hello)

    # 注册钩子
    ctx.on_startup(on_startup)
    ctx.on_shutdown(on_shutdown)
    ctx.on_snapshot(on_snapshot)
    ctx.on_settings_saved(on_settings_saved)

    # 读取 / 保存设置
    settings = ctx.get_settings()
    log.info("plugin loaded, refresh interval = {}", (settings.get("general") or {}).get("refresh_interval"))

    # 启动完成后主动向前端发送一个事件
    ctx.on_startup(lambda: ctx.emit("example_hello", {"message": "welcome from example_basic"}))

    log.info("example_basic registered")
