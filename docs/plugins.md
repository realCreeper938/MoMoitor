# 插件系统

MoMoitor 提供了一个完整的插件系统，让开发者可以：

- 往页面 `<head>` 和 `<body>` 注入自定义内容（HTML / CSS / JS）
- 注册全新的卡片（复用现有布局系统的拖拽、缩放、卡片列表功能）
- 注册新的数据源（替代内置的 LHM / HWiNFO 后端）
- 注册新的配色主题（出现在 设置-主题 中）
- 注册自定义的 JS 桥接 API 方法（前端可 `pywebview.api.xxx()` 调用）
- 在轮询快照、应用启动、应用退出、设置保存等生命周期挂接钩子
- 在设置页中注册新的标签页 / 设置分组 / 设置项
- 扩展国际化词典，向前端主动推送事件

---

## 目录结构

插件存放在项目根目录（开发）或可执行文件同目录（打包后）的 `./plugins/` 下，每个插件一个子目录，目录名必须是合法的 Python 标识符（`[A-Za-z_][A-Za-z0-9_]*`）：

```
plugins/
├── my_plugin/              # 目录名即插件 id
│   ├── config.py           # 必需：插件元信息
│   ├── __init__.py         # 可选：Python 端逻辑（register 入口）
│   ├── monitor.py          # 可选：数据源 Monitor 类（约定文件，非强制）
│   └── frontend/           # 可选：前端资源，启用后注入页面
│       ├── head.html       # 追加到 <head> 的 HTML
│       ├── body.html       # 追加到 <body> 的 HTML
│       ├── style.css       # 追加到 <head> 的 <style>
│       └── main.js         # 追加到 <body> 尾部的脚本（按插件顺序执行）
└── ...
```

程序启动时会扫描 `./plugins/` 下所有目录，校验 `config.py`。无效插件会被标记并在 设置-插件 中显示原因，但不会阻止程序运行。

---

## config.py（插件元信息）

`config.py` 是一个普通的 Python 模块，定义以下模块级变量：

| 变量 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `NAME` | str | 是 | 插件显示名称 |
| `VERSION` | str | 是 | 版本号，如 `"1.0.0"` |
| `AUTHOR` | str | 是 | 作者 |
| `DESCRIPTION` | str | 否 | 描述，显示在 设置-插件 中 |
| `HOMEPAGE` | str | 否 | 项目主页，显示为可点击链接 |

**插件没有类型概念。** 所有插件都是普通插件，能力完全由 `__init__.py` 中的 `register(ctx)` 决定：

- 想提供配色主题 → 调用 `ctx.register_theme(...)`
- 想提供硬件数据源 → 调用 `ctx.register_data_source(...)`
- 想提供卡片 / 设置项 / API 方法 / 钩子 → 分别调用对应的 PluginContext 方法

一个插件可以同时注册主题、数据源和卡片，互不冲突。只有一个 `config.py` 的纯前端插件也合法，此时程序只注入其 `frontend/` 资源。

### 注册主题

```python
# __init__.py
def register(ctx):
    ctx.register_theme({
        "value": "mytheme",          # 写入设置 colorscheme 的值，需唯一
        "name": "My Theme",          # 显示名称（默认取插件名称）
        "dark": True,                # True=深色主题，False=浅色主题
        "colors": {                  # 必需：CSS 变量名（去掉 -- 前缀）-> 值
            "nord0": "#1c1c1c",
            "nord1": "#242424",
            "nord2": "#2e2e2e",
            "nord3": "#3a3a3a",
            "nord4": "#e0e0e0",
            "nord5": "#b8b8b8",
            "nord6": "#8a8a8a",
            "nord7": "#6f6f6f",
            "nord8": "#56b6c2",
            "nord9": "#d19a66",
            "nord10": "#61afef",
            "nord11": "#e06c75",
            "nord12": "#98c379",
            "nord13": "#c678dd",
            "nord14": "#e5c07b",
            "bg_rgb": "28, 28, 28",     # 背景 RGB（不带括号）
            "metric_cpu": "#98c379",
            "metric_gpu": "#61afef",
            "metric_mem": "#e5c07b",
            "metric_fps": "#d19a66",
        },
    })
```

参考 `style.css` 中 `[data-colorscheme="..."]` 选择器即可知道有哪些变量可覆盖。`value` 与 `colors` 必需，其余可选。注册后主题自动出现在 设置-主题 的候选列表中。

### 注册数据源

```python
# __init__.py
from .monitor import Monitor  # 或直接把 Monitor 类写在 __init__.py 里

def register(ctx):
    ctx.register_data_source(
        {
            "value": "demo",      # 写入设置 data_source 的值，需唯一
            "label": "Demo",      # 下拉框显示名（默认取插件名称）
            "description": "...", # 可选描述
        },
        Monitor,                 # 必须：可实例化的后端类（继承 PluginMonitor）
    )
```

注册后数据源会出现在 设置-数据 的数据源下拉框中。选择后点击保存会立即切换后端；程序重启后仍使用该数据源。内置的 `lhm` / `hwinfo` 始终可用，不冲突。`Monitor` 类的实现约定见下文「PluginMonitor（数据源后端协议）」。

---

## Python 端 API（PluginContext）

如果插件目录下有 `__init__.py`，它会被作为 Python 模块导入。程序会在启动时：

1. 导入插件模块；
2. 如果模块定义了 `register(ctx)` 函数，则调用它，传入一个 `PluginContext`；
3. 自动注册模块顶层名为 `on_snapshot` / `on_startup` / `on_shutdown` / `on_settings_saved` 的钩子函数（如果存在）。

### PluginContext 提供的能力

| 成员 | 说明 |
| --- | --- |
| `ctx.id` | 插件 id（目录名） |
| `ctx.info` | `PluginInfo` 对象（名称、类型、版本、作者等） |
| `ctx.log` | 已绑定 `plugin=<id>` 的 loguru logger |
| `ctx.api` | 当前 `Api` 实例（在 `register` 阶段可能为 `None`，启动完成后可用） |
| `ctx.get_settings()` | 返回完整设置字典的深拷贝 |
| `ctx.save_settings(s)` | 保存完整设置并触发其他插件的 `on_settings_saved` 钩子 |
| `ctx.add_api_method(name, fn)` | 注册一个 JS 桥接方法，前端可用 `pywebview.api.<name>(...)` 调用 |
| `ctx.register_theme(theme)` | 注册一个配色主题，自动出现在 设置-主题 中 |
| `ctx.register_data_source(config, monitor_cls)` | 注册一个硬件数据源，出现在 设置-数据 下拉框中 |
| `ctx.on_snapshot(fn)` | 快照钩子：`fn(data) -> data|None`，可原地修改或整体替换 |
| `ctx.on_startup(fn)` | 启动完成钩子（Api 挂载后调用） |
| `ctx.on_shutdown(fn)` | 程序退出钩子，可做清理 |
| `ctx.on_settings_saved(fn)` | 设置保存钩子，`fn(settings)` |
| `ctx.call_js(code)` | 在前端执行一段 JS（需要窗口已创建） |
| `ctx.emit(event, data)` | 向前端派发事件：`PluginApi.on(event, ...)` 可订阅 |

### 注册 API 方法

```python
def register(ctx):
    def my_function(name="world"):
        return "Hello, " + name

    ctx.add_api_method("my_function", my_function)
```

前端调用：

```js
const res = await pywebview.api.my_function("MoMoitor"); // "Hello, MoMoitor"
```

注意：

- 插件函数按**普通函数**编写，不需要 `self` 参数；
- 方法名不能与内置 API（`get_data`、`get_settings`、`save_settings`、`get_plugins`、`close_app` 等）重名，也不能与其他插件冲突，否则会抛出 `PluginError`；
- 函数可返回任意 JSON 可序列化的值，或 `awaitable`（pywebview / 服务端模式都会自动处理）。

### 快照钩子

`on_snapshot` 会在每次轮询硬件数据后执行，返回值决定是否替换整体快照：

```python
def on_snapshot(data):
    data["my_extra"] = {"now": time.time()}   # 原地修改
    return data                               # 返回非 None 表示接受修改

ctx.on_snapshot(on_snapshot)
```

前端可以用 `PluginApi.onPoll(data)` 拿到每个轮询周期的快照（包含插件注入的字段）。

### 事件通信（Python -> 前端）

```python
ctx.emit("my_event", {"message": "hello"})
```

前端：

```js
PluginApi.on("my_event", (payload) => {
    console.log(payload.message);
});
```

`PluginApi.emit(event, data)` 实现前端内部广播；`PluginApi._receiveFromPython` 是后端事件入口。

---

## 前端 API（PluginApi）

`frontend/main.js` 通过全局对象 `PluginApi` 与 MoMoitor 交互。脚本在启动时按插件的字母顺序注入并立即执行。

| 方法 | 说明 |
| --- | --- |
| `registerCard(def)` | 注册一张卡片，自动接入布局系统 |
| `onReady(fn)` | 所有卡片启动完成后调用 |
| `onPoll(fn)` | 每个轮询周期调用，`fn(data)` 参数是完整快照 |
| `on(event, fn)` / `emit(event, data)` | 订阅 / 广播本地事件 |
| `onSettingsOpen(fn)` | 打开设置页时调用 |
| `onSettingsSave(fn)` | 点击保存、写入前调用，`fn(s)` 可修改 s |
| `onSettingsSaved(fn)` | 保存成功、缓存更新后调用 |
| `registerSettingsGroup({tab,id,title,html,onLoad,onSave})` | 在某个设置标签页中追加一组设置项 |
| `getSettings()` | 返回当前设置缓存（`window._appSettings`） |
| `saveSettings()` | 保存当前设置 |
| `addI18n(lang, dict)` | 合并进国际化词典并立即生效 |
| `t(key)` | 取翻译文本 |
| `addStyle(css)` / `addHead(html)` / `addBody(html)` | 运行时注入样式 / head / body |
| `el(id)` | `document.getElementById` 的简写 |
| `toast(msg)` | 显示一个提示条 |
| `openExternal(url)` | 用系统浏览器打开链接 |

### registerCard

```js
PluginApi.registerCard({
    id: "my-card",                    // 卡片元素 id，必须唯一
    title: { en: "My Card", zh: "我的卡片" },  // 或直接传字符串
    label: "MY",                      // 左上角小标签（可选）
    color: "var(--orange)",           // 卡片列表中的标识色（可选）
    interval: 2000,                   // 刷新间隔（毫秒），不传则不自动刷新
    layout: { col: 2, row: 6, span: 1 },  // 默认布局（可选）
    resizable: true,                  // 是否允许缩放（默认 true）
    getData: async () => ({ ... }),   // 可选：异步取数，结果传给 render
    render(el, data) { ... },         // 渲染函数（必需）
});
```

- 卡片会自动成为 `.term-box`，获得拖拽手柄、角标、标题栏，并出现在布局工具栏 / 卡片列表中；
- `getData` 返回的数据会传给 `render`；没有 `getData` 时 `render(el)` 直接被调用；
- 刷新由 `PluginApi` 内部的 `setInterval` 驱动，不需要关心布局系统；
- 复用现有样式类即可保持外观一致：`.split-row`、`.data-col`、`.value-row`、`.metric-value big mono`、`.info-line`、`.hw-name` 等。

### registerSettingsGroup

```js
PluginApi.registerSettingsGroup({
    tab: "general",      // 目标标签页 id（tab-general 的 general）
    id: "my-group",      // 唯一 id
    title: { en: "My Group", zh: "我的分组" },
    html: '<div class="setting-item">...</div>',
    onLoad() { ... },    // 设置页打开时调用
    onSave(s) { ... },   // 点击保存时调用，可读取表单值写入 s
});
```

该分组会被追加到对应标签页的末尾，样式与内置设置分组一致。

---

## PluginMonitor（数据源后端协议）

注册数据源时传入的 `monitor_cls` 通常继承 `PluginMonitor`（把类放在 `monitor.py` 里只是惯例，也可以直接写在 `__init__.py` 中）。`PluginMonitor` 的抽象方法只有 `snapshot()`，其余均有默认实现：

| 方法 | 默认实现 | 说明 |
| --- | --- | --- |
| `snapshot(gpu_index=None)` | 抽象方法 | **必须实现**：返回一次硬件快照字典 |
| `get_backend_info()` | `{name: <类名>, version: None}` | 后端名称与版本 |
| `get_hw_names()` | `{cpu:'CPU', gpu:'GPU', mem:'Memory', disk:'Disk Status'}` | 硬件显示名 |
| `get_gpu_list()` | `[]` | GPU 列表 |
| `get_hw_detail(gpu_index=None)` | `{cpu:{},gpu:{},mem:{}}` | 硬件详情 |
| `get_memory()` | 从 `snapshot()['mem']` 推导 | 内存数据 |
| `close()` | 空操作 | 切换后端时调用 |

### snapshot() 字典结构

```python
{
    "cpu": {"clock", "temp", "power", "load", "voltage"},
    "gpu": {"temp", "power", "load", "vram_used_gb", "vram_total_gb", "vram_temp"},
    "mem": {"used_gb", "total_gb", "percent", "temp", "volt", "clock"},
    "disks": [{"letter", "used_gb", "total_gb", "percent"}, ...],
    "disk_status": {"activity", "temp", "read", "write"},
    "net": {"up", "down", "name"},
}
```

字段缺失时前端会显示为空或默认值；`snapshot()` 内可以做平滑 / 缓存，不必每次真实采集。数值中的 `NaN` / `Inf` 会被后端清理。

---

## 生命周期

1. **启动扫描**：`main.py` 加载设置后调用 `init_manager(settings)`，扫描 `./plugins/` 并激活启用中的插件（执行各插件的 `register(ctx)`，注册主题 / 数据源 / API 方法 / 钩子）；
2. **前端资源注入**：前端启动时调用 `get_plugin_frontend()`，按插件注入 head / body / style / script；
3. **主题注入**：`get_plugin_themes()` 返回插件注册的主题，注入 CSS 变量并加入 设置-主题 列表；
4. **数据源**：创建硬件后端时，`create_monitor()` 优先尝试插件数据源，失败则回退到内置后端；`create_api()` 创建 `Api` 时挂载插件 API 方法并触发 `on_startup`；
5. **运行中**：每次轮询经过 `on_snapshot` 钩子链；设置保存经过 `on_settings_saved`；
6. **退出**：`main.py` 退出前调用 `shutdown_manager()`，触发各插件的 `on_shutdown`。

### 启用 / 禁用

在 设置-插件 页面勾选即可。开关会写入 `settings.plugins.enabled`，**重启后生效**。禁用不会卸载已加载的 Python 模块，但会停止注入其前端资源（下次重启才完全移除）。

---

## 示例插件

仓库自带的四个示例覆盖了几乎全部接口，可直接参考：

| 目录 | 演示内容 |
| --- | --- |
| `plugins/example_basic` | head/body/style/script 注入、卡片、API 方法、快照钩子、生命周期钩子、设置分组、i18n、Python→前端事件 |
| `plugins/example_theme` | 通过 `register(ctx)` + `ctx.register_theme()` 提供完整配色 |
| `plugins/example_data_source` | 通过 `register(ctx)` + `ctx.register_data_source()` 注册后端，`Monitor` 类产生平滑随机数据 |
| `plugins/example_widget` | 纯前端卡片（无 Python 代码） |

启用示例插件后重启程序即可看到效果（示例卡片、Uptime 卡片、Synthwave 主题、Demo 数据源）。
