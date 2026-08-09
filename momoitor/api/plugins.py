"""API 插件 mixin —— 把插件管理能力暴露给前端 JS。

PluginMixin 提供的接口:
    get_plugins()              设置页「插件」列表
    set_plugin_enabled()       开启/关闭插件（写入设置，下次启动生效）
    get_plugin_frontend()      已启用插件的前端资源（head/body/style/script）
    get_plugin_themes()        插件注册的配色列表
    get_plugin_data_sources()  插件注册的数据源下拉项列表
"""


class PluginMixin:
    """插件管理相关的 JS 桥接方法。"""

    def get_plugins(self):
        return self._plugin_manager.plugins_list()

    def set_plugin_enabled(self, plugin_id, enabled):
        return self._plugin_manager.set_enabled(str(plugin_id), bool(enabled))

    def get_plugin_frontend(self):
        return self._plugin_manager.frontend_bundle()

    def get_plugin_themes(self):
        return self._plugin_manager.themes()

    def get_plugin_data_sources(self):
        return self._plugin_manager.data_sources()
