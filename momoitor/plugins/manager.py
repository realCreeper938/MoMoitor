"""插件管理器 —— 扫描、加载、启用插件并向外提供统一接口。

流程:
    scan()     启动时扫描 PLUGINS_DIR 下所有子目录，校验 config.py，
               得到「有效插件」列表（_discovered）与「无效目录」列表（_invalid）。
    activate() 依据 settings.plugins.enabled 启用插件：加载 __init__.py
               并调用其 register(ctx)（若存在），或自动注册模块级钩子。
    attach(api) 在 Api 创建后调用，把插件注册的 API 方法绑定到 Api，
               并触发 startup 钩子。

单例:
    通过 momoitor.plugins.get_manager() 获取全局唯一的 PluginManager。
"""

import copy
import importlib
import importlib.util
import json
import os
import re
import sys

from loguru import logger

from momoitor.config import PLUGINS_DIR, load_settings, save_settings
from momoitor.config import _normalize_settings

from .base import PluginContext, PluginError, PluginInfo

_HOOK_NAMES = ("snapshot", "startup", "shutdown", "settings_saved")

# 插件目录名必须同时是可导入的 Python 模块名。
_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _make_invalid(name: str, error: str) -> PluginInfo:
    info = PluginInfo(id=name, name=name, valid=False, error=error)
    logger.warning("Invalid plugin dir '{}': {}", name, error)
    return info


class PluginManager:
    """插件生命周期与注册表管理。"""

    def __init__(self, settings: dict):
        self._settings = settings
        self._dir = PLUGINS_DIR
        self._discovered = {}      # id -> PluginInfo（有效插件）
        self._invalid = []         # [PluginInfo]（无效目录，仅供列表展示）
        self._loaded = {}          # id -> PluginInfo（已激活）
        self._themes = {}          # id -> theme dict（插件运行时注册的主题）
        self._data_sources = {}    # value -> {"config", "monitor_cls", "plugin_id"}（注册的数据源）
        self._api = None
        self._api_methods = {}     # name -> fn（待绑定的插件 API 方法）
        self._hooks = {name: [] for name in _HOOK_NAMES}
        self._scanned = False
        self._activated = False
        self._shutdown_called = False

    # ── 属性 ──────────────────────────────────────────────────

    @property
    def api(self):
        return self._api

    @property
    def plugins_dir(self) -> str:
        return self._dir

    # ── 扫描 / 激活 ───────────────────────────────────────────

    def scan(self):
        """扫描插件目录。幂等，仅首次执行。"""
        if self._scanned:
            return
        self._scanned = True
        if not os.path.isdir(self._dir):
            logger.info("Plugins dir not found: {}", self._dir)
            return
        for name in sorted(os.listdir(self._dir)):
            path = os.path.join(self._dir, name)
            if not os.path.isdir(path):
                continue
            if name.startswith("_") or name.startswith("."):
                continue
            if not _NAME_RE.fullmatch(name):
                self._invalid.append(_make_invalid(name, "目录名不是合法的 Python 标识符"))
                continue
            info = self._load_config(name, path)
            if info.valid:
                self._discovered[info.id] = info
            else:
                self._invalid.append(info)
        logger.info("Plugin scan done: {} valid, {} invalid", len(self._discovered), len(self._invalid))

    def activate(self):
        """依据设置启用插件。幂等。"""
        if self._activated:
            return
        self._activated = True
        enabled = set(self._settings.get("plugins", {}).get("enabled", []) or [])
        for pid, info in self._discovered.items():
            info.enabled = pid in enabled
            if info.enabled and info.valid:
                self._activate_one(info)

    def _activate_one(self, info: PluginInfo):
        """激活单个插件：加载模块、调用 register()、注册模块级钩子。"""
        module = None
        init_file = os.path.join(info.path, "__init__.py")
        if os.path.isfile(init_file):
            self._ensure_syspath()
            try:
                module = importlib.import_module(info.id)
            except Exception as e:
                self._mark_failed(info, "插件加载失败: {}".format(e))
                return

        ctx = PluginContext(self, info)
        try:
            # 自动注册模块级钩子函数（与 register() 中的写法等价）
            for hook in _HOOK_NAMES:
                fn = getattr(module, hook, None) if module is not None else None
                if callable(fn):
                    getattr(ctx, "on_" + hook)(fn)
            # register(ctx) 是主入口，可选
            if module is not None and callable(getattr(module, "register", None)):
                module.register(ctx)
        except Exception as e:
            self._mark_failed(info, "register() 执行失败: {}".format(e))
            return
        self._loaded[info.id] = info
        logger.info("Plugin enabled: {} v{} ({})", info.name, info.version, info.id)

    def _mark_failed(self, info: PluginInfo, error: str):
        info.valid = False
        info.error = error
        logger.error("Failed to activate plugin {}: {}", info.id, error)

    # ── 配置加载 ──────────────────────────────────────────────

    def _load_config(self, name: str, path: str) -> PluginInfo:
        cfg_file = os.path.join(path, "config.py")
        if not os.path.isfile(cfg_file):
            return _make_invalid(name, "缺少 config.py")
        module = self._exec_file("_momoitor_plugin_config_" + name, cfg_file)
        if module is None:
            return _make_invalid(name, "config.py 加载失败")

        cfg = {k: v for k, v in vars(module).items() if not k.startswith("_")}
        for key in ("NAME", "VERSION", "AUTHOR"):
            value = cfg.get(key)
            if not isinstance(value, str) or not value.strip():
                return _make_invalid(name, "缺少字符串配置 {}".format(key))

        info = PluginInfo(
            id=name,
            name=cfg["NAME"].strip(),
            version=cfg["VERSION"].strip(),
            author=cfg["AUTHOR"].strip(),
            description=str(cfg.get("DESCRIPTION", "") or ""),
            homepage=str(cfg.get("HOMEPAGE", "") or ""),
            path=path,
            config=cfg,
        )

        return info

    def _exec_file(self, module_name: str, path: str):
        """以独立模块名加载任意 .py 文件，失败返回 None。"""
        try:
            spec = importlib.util.spec_from_file_location(module_name, path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        except Exception as e:
            logger.error("Failed to load {}: {}", path, e)
            return None

    def _ensure_syspath(self):
        """把插件根目录加入 sys.path，使插件可作为顶层包导入。"""
        root = os.path.abspath(self._dir)
        if root not in sys.path:
            sys.path.insert(0, root)

    # ── API 方法绑定 ──────────────────────────────────────────

    def add_api_method(self, name: str, fn):
        """注册插件 API 方法。Api 已创建则立即绑定。"""
        if not isinstance(name, str) or not name:
            raise PluginError("API 方法名不能为空")
        if not name.startswith("_") and (name in _API_FORBIDDEN):
            raise PluginError("API 方法名 {} 与内置方法冲突".format(name))
        if name in self._api_methods:
            raise PluginError("API 方法 {} 已被其他插件注册".format(name))
        self._api_methods[name] = fn
        if self._api is not None:
            self._bind(self._api, name, fn)

    def attach(self, api):
        """Api 创建后调用：绑定所有插件 API 方法并触发启动钩子。"""
        self._api = api
        for name, fn in self._api_methods.items():
            self._bind(api, name, fn)
        self.run_startup_hooks()

    @staticmethod
    def _bind(api, name: str, fn):
        """把插件函数挂载为 Api 的实例属性。

        直接 setattr 为普通函数：pywebview 的 get_functions() 通过
        dir(instance) 遍历实例属性，普通函数同样满足 isfunction()，
        因此会被暴露给前端；服务端模式 getattr(api, name)(*args)
        也能正常调用。插件作者按普通函数编写（无需 self）。
        """
        setattr(api, name, fn)

    # ── 能力注册（register() 中调用）──────────────────────────

    def register_theme(self, plugin_id: str, theme: dict) -> None:
        """插件在 register(ctx) 中注册主题。"""
        theme = dict(theme or {})
        colors = theme.get("colors")
        if not isinstance(colors, dict) or not colors:
            raise PluginError("主题需要 colors 配色字典")
        if theme.get("value") in [t.get("value") for t in self._themes.values()]:
            raise PluginError("主题 {} 已被其他插件注册".format(theme.get("value")))
        info = self._discovered.get(plugin_id)
        theme.setdefault("value", plugin_id)
        theme.setdefault("name", info.name if info else plugin_id)
        theme.setdefault("dark", True)
        self._themes[plugin_id] = theme

    def register_data_source(self, plugin_id: str, config: dict, monitor_cls) -> None:
        """插件在 register(ctx) 中注册数据源。"""
        if not callable(monitor_cls):
            raise PluginError("数据源需要传入可实例化的 Monitor 类")
        cfg = dict(config or {})
        value = cfg.get("value") or plugin_id
        if value in self._data_sources:
            raise PluginError("数据源 {} 已被其他插件注册".format(value))
        info = self._discovered.get(plugin_id)
        cfg.setdefault("value", value)
        cfg.setdefault("label", info.name if info else plugin_id)
        self._data_sources[value] = {
            "config": cfg,
            "monitor_cls": monitor_cls,
            "plugin_id": plugin_id,
        }

    # ── 数据源 ────────────────────────────────────────────────

    def create_monitor(self, source: str):
        """按数据源 value 查找已注册的数据源插件并实例化其 Monitor。

        找不到（未注册/加载失败）时返回 None，调用方回退到内置后端。
        """
        if not source:
            return None
        entry = self._data_sources.get(source)
        if entry is None:
            return None
        try:
            return entry["monitor_cls"]()
        except Exception as e:
            logger.error("Plugin {} Monitor init failed: {}", entry["plugin_id"], e)
            return None

    # ── 前端资源 ──────────────────────────────────────────────

    def frontend_bundle(self) -> dict:
        """收集所有已启用插件的前端资源（head / body / style / script）。"""
        plugins = []
        for pid, info in self._discovered.items():
            if not info.valid or not info.enabled:
                continue
            bundle = self._read_frontend(info)
            if any(bundle.values()):
                bundle["id"] = info.id
                plugins.append(bundle)
        return {"plugins": plugins}

    @staticmethod
    def _read_frontend(info: PluginInfo) -> dict:
        fdir = os.path.join(info.path, "frontend")
        result = {"head": "", "body": "", "styles": "", "scripts": ""}
        if not os.path.isdir(fdir):
            return result
        for key, filename in (("head", "head.html"), ("body", "body.html"),
                              ("styles", "style.css"), ("scripts", "main.js")):
            path = os.path.join(fdir, filename)
            if os.path.isfile(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        result[key] = f.read()
                except OSError as e:
                    logger.warning("Failed to read plugin frontend {}: {}", path, e)
        return result

    # ── 对外查询 ──────────────────────────────────────────────

    def themes(self) -> list:
        """已注册主题的字典列表（供前端注册配色）。

        插件通过 register(ctx) 里的 ctx.register_theme() 注册。
        """
        return list(self._themes.values())

    def data_sources(self) -> list:
        """已注册数据源的 config 字典列表（供设置页下拉框）。

        插件通过 register(ctx) 里的 ctx.register_data_source() 注册。
        """
        return [entry["config"] for entry in self._data_sources.values()]

    def plugins_list(self) -> list:
        """设置页「插件」列表：有效插件 + 无效目录，按 id 排序。"""
        items = [self._to_dict(i) for i in self._discovered.values()]
        items.extend(self._to_dict(i) for i in self._invalid)
        items.sort(key=lambda x: x["id"].lower())
        return items

    @staticmethod
    def _to_dict(info: PluginInfo) -> dict:
        return {
            "id": info.id,
            "name": info.name,
            "type": "plugin",
            "version": info.version,
            "author": info.author,
            "description": info.description,
            "homepage": info.homepage,
            "enabled": info.enabled,
            "valid": info.valid,
            "error": info.error,
        }

    # ── 设置 ──────────────────────────────────────────────────

    def _current_settings(self) -> dict:
        """当前生效的设置：优先使用已挂载 Api 实例的最新设置。

        ApiCore.save_settings 每次保存都会更新其 _settings，而插件管理器
        持有的 _settings 只是启动时的快照。开关插件前必须先取 Api 的最新值，
        否则会把启动快照整体写回，覆盖用户后续保存的其他配置。
        """
        if self._api is not None and hasattr(self._api, "_settings"):
            return copy.deepcopy(self._api._settings)
        return copy.deepcopy(self._settings)

    def get_settings(self) -> dict:
        return self._current_settings()

    def save_settings(self, settings: dict) -> bool:
        normalized = _normalize_settings(settings)
        self._settings = normalized
        save_settings(normalized)
        if self._api is not None and hasattr(self._api, "_settings"):
            self._api._settings = copy.deepcopy(normalized)
        self._run_settings_saved_hooks(normalized)
        return True

    def set_enabled(self, plugin_id: str, enabled: bool) -> dict:
        """开启/关闭插件。改动写入设置，下次启动生效。"""
        info = self._discovered.get(plugin_id)
        if info is None or not info.valid:
            return {"ok": False, "error": "插件不存在或无效"}
        # 以 Api 的最新设置为基础修改，避免用启动快照覆盖后续保存的配置
        settings = self._current_settings()
        enabled_list = settings.setdefault("plugins", {}).setdefault("enabled", [])
        if enabled and plugin_id not in enabled_list:
            enabled_list.append(plugin_id)
        elif not enabled and plugin_id in enabled_list:
            enabled_list.remove(plugin_id)
        info.enabled = bool(enabled)
        settings = _normalize_settings(settings)
        self._settings = settings
        save_settings(settings)
        # 同步回 Api 实例，保持内存与磁盘一致
        if self._api is not None and hasattr(self._api, "_settings"):
            self._api._settings = copy.deepcopy(settings)
        logger.info("Plugin {} {}", plugin_id, "enabled" if enabled else "disabled")
        return {"ok": True, "restart_required": True}

    # ── 钩子执行 ──────────────────────────────────────────────

    def add_hook(self, name: str, fn):
        if name not in self._hooks:
            raise PluginError("未知钩子类型: {}".format(name))
        if not callable(fn):
            raise PluginError("钩子必须是可调用对象")
        self._hooks[name].append(fn)

    def apply_snapshot_hooks(self, data: dict) -> dict:
        """依次调用快照钩子；钩子返回的新字典会替换当前数据。"""
        if not self._hooks["snapshot"]:
            return data
        for fn in list(self._hooks["snapshot"]):
            try:
                result = fn(data)
                if result is not None:
                    data = result
            except Exception as e:
                logger.error("plugin snapshot hook failed: {}", e)
        return data

    def run_startup_hooks(self):
        self._run_simple_hooks("startup")

    def run_shutdown_hooks(self):
        if self._shutdown_called:
            return
        self._shutdown_called = True
        self._run_simple_hooks("shutdown")

    def _run_simple_hooks(self, name: str):
        for fn in list(self._hooks[name]):
            try:
                fn()
            except Exception as e:
                logger.error("plugin {} hook failed: {}", name, e)

    def _run_settings_saved_hooks(self, settings: dict):
        for fn in list(self._hooks["settings_saved"]):
            try:
                fn(settings)
            except Exception as e:
                logger.error("plugin settings_saved hook failed: {}", e)

    # ── 前端通信 ──────────────────────────────────────────────

    def call_js(self, code: str):
        api = self._api
        window = getattr(api, "_window", None) if api is not None else None
        if window is None:
            logger.debug("call_js ignored: no window yet")
            return None
        try:
            return window.evaluate_js(code)
        except Exception as e:
            logger.warning("call_js failed: {}", e)
            return None

    def notify_frontend(self, event: str, data=None):
        """把事件推送给前端。前端用 PluginApi.on(event, handler) 订阅。"""
        payload = json.dumps({"event": event, "data": data}, ensure_ascii=False, default=str)
        return self.call_js(
            "window.PluginApi && PluginApi._receiveFromPython(" + payload + ")"
        )


# 插件 API 方法不允许覆盖的内置核心方法名。
_API_FORBIDDEN = frozenset({
    "get_data", "get_settings", "save_settings", "get_plugins",
    "set_plugin_enabled", "get_plugin_frontend", "get_plugin_themes",
    "get_plugin_data_sources", "js_log", "close_app",
})
