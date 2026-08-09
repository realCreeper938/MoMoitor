"""插件系统的公共类型定义。

这里定义了插件系统中被反复引用的基础类型：
- PluginError: 插件相关异常
- PluginInfo: 单个插件的元信息（扫描 config.py 得到）
- PluginContext: 传给插件 register() 的上下文，插件通过它注册能力

插件开发者一般只需要理解 PluginContext；其余类型由管理器内部使用。
"""

from dataclasses import dataclass, field

from loguru import logger


class PluginError(Exception):
    """插件相关错误。管理器捕获后会把错误记录到插件的 error 字段。"""


@dataclass
class PluginInfo:
    """扫描 config.py 后得到的插件元信息。

    由 PluginManager 填充，valid=False 表示该插件目录不合法、
    无法被加载或启用（error 字段说明原因）。
    """

    id: str = ""
    name: str = ""
    version: str = ""
    author: str = ""
    description: str = ""
    homepage: str = ""
    path: str = ""
    config: dict = field(default_factory=dict)
    valid: bool = True
    error: str = ""
    enabled: bool = False


class PluginContext:
    """插件在 register(ctx) 中拿到的上下文对象。

    它是插件与 MoMoitor 之间的唯一桥梁。插件通过它：
    - ctx.add_api_method(name, fn)   注册新的前端 API 方法
    - ctx.on_snapshot(fn)            挂接硬件快照钩子（可修改数据）
    - ctx.on_startup / on_shutdown   生命周期钩子
    - ctx.on_settings_saved(fn)      设置保存后回调
    - ctx.call_js(code) / ctx.emit   主动与前端通信
    - ctx.get_settings / save_settings 读写设置
    """

    def __init__(self, manager, info: PluginInfo):
        self._manager = manager
        self._info = info

    @property
    def id(self) -> str:
        return self._info.id

    @property
    def info(self) -> PluginInfo:
        return self._info

    @property
    def log(self):
        """绑定到本插件的 loguru logger，日志会带 plugin=插件名 上下文。"""
        return logger.bind(plugin=self._info.id)

    @property
    def api(self):
        """当前 Api 实例（pywebview 桥接对象）。

        注意：register() 执行时 Api 可能尚未创建（返回 None）。
        请使用 ctx.add_api_method() 注册前端可调用的方法，
        而不要在 register() 中直接依赖 api 的实例状态。
        """
        return self._manager.api

    def get_settings(self) -> dict:
        """读取当前设置（深拷贝，修改不会写回磁盘）。"""
        return self._manager.get_settings()

    def save_settings(self, settings: dict) -> bool:
        """整体保存设置（会自动规范化并写回 data/settings.json）。"""
        return self._manager.save_settings(settings)

    def add_api_method(self, name: str, fn) -> None:
        """注册一个前端可调用的 API 方法。

        前端可以用 pywebview.api.<name>(...) 调用 fn。
        若 Api 尚未创建，该方法会被暂存并在 Api 就绪后自动绑定。
        """
        self._manager.add_api_method(name, fn)

    def on_snapshot(self, fn) -> None:
        """注册硬件快照钩子。

        fn(data) 会在每次获取硬件快照后调用，data 为快照字典。
        返回新字典可替换快照；返回 None 表示不做修改。
        多次注册按注册顺序依次调用。
        """
        self._manager.add_hook("snapshot", fn)

    def on_startup(self, fn) -> None:
        """注册启动钩子：程序初始化完成、Api 可用时调用 fn()。"""
        self._manager.add_hook("startup", fn)

    def on_shutdown(self, fn) -> None:
        """注册关闭钩子：程序退出前调用 fn()。"""
        self._manager.add_hook("shutdown", fn)

    def on_settings_saved(self, fn) -> None:
        """注册设置保存钩子：设置被保存后调用 fn(settings)。"""
        self._manager.add_hook("settings_saved", fn)

    def register_theme(self, theme: dict) -> None:
        """注册一个主题（配色方案）。

        theme 为字典，可包含:
        - value: 配色方案的值（写入设置 colorscheme，需唯一；缺省用插件 id）
        - name: 显示名称（缺省用插件名称）
        - dark: 是否为深色主题（缺省 True）
        - colors: 配色字典，key 为 CSS 变量名去掉 -- 前缀
          （nord0 ~ nord14、bg_rgb、metric_cpu/gpu/mem/fps 等）

        注册后主题会出现在 设置-主题 的候选列表中，并在启动时注入前端。
        """
        self._manager.register_theme(self.id, theme)

    def register_data_source(self, config: dict, monitor_cls) -> None:
        """注册一个数据源（自定义硬件后端）。

        config 为字典，可包含:
        - value: 数据源的值（写入设置 data_source，需唯一；缺省用插件 id）
        - label: 下拉框中显示的名称（缺省用插件名称）
        - description: 描述（可选）

        monitor_cls 是一个类（通常继承 PluginMonitor），MoMoitor 会在需要时
        实例化它作为硬件后端。注册后数据源会出现在 设置-数据 的下拉框中。
        """
        self._manager.register_data_source(self.id, config, monitor_cls)

    def call_js(self, code: str):
        """在当前页面执行一段 JavaScript 并返回其结果。"""
        return self._manager.call_js(code)

    def emit(self, event: str, data=None):
        """向前端派发自定义事件。

        前端通过 PluginApi.on(event, handler) 订阅。
        """
        return self._manager.notify_frontend(event, data)
