# 运行入口

## main.py

```
python -m momoitor.main
```

| 函数 | 说明 |
|---|---|
| `main()` | 入口。初始化日志（`debug_logs` 控制级别）、`_cleanup_webview2_data()` 清 WebView2 过期锁文件、创建后端监视器（失败弹错误框退出）；按设置 `server_mode` 分发到 `_run_webview` 或 `_run_server`，退出时 `close_monitor()` |
| `_run_webview(monitor, settings, t0)` | `_hide_console()` 隐藏控制台后 `create_window` 建窗口，`webview.start(debug=settings.debug)` 进入事件循环 |
| `_run_server(monitor, settings, t0)` | `create_api` + `server.run_server` 启动 HTTP 服务端模式 |
| `_hide_console()` | 隐藏控制台窗口（pythonw 下无控制台时无操作） |
| `_show_error(title, msg)` | 崩溃时弹错误框（打包为无控制台 exe，错误必须可见） |

无命令行参数，桌面/服务端模式由设置 `server_mode` 决定。开机自启通过 `python -m momoitor.main` 启动。

## server.py（HTTP 服务端模式）

| 函数/类 | 说明 |
|---|---|
| `run_server(api, settings)` | 按设置构造 `ServerBackend`、绑定 `api.set_server_backend` 并 `start()` |
| `class ServerBackend(api, host, port, auth_enabled, auth_user, auth_pass)` | 静态文件 + JSON API 的 bottle 服务 |
| `ServerBackend.start()` / `stop()` | 启动/停止（`_thread` 后台线程） |
| API 路由 | `/api/<method>` 经 `getattr(api, method)` 分发，支持 JSON 参数；可选 BasicAuth；`/api/health` 健康检查 |

## 启动流程

1. `main.main()` → 按设置 `data_source` 创建后端监视器 `api.create_monitor()`
2. 桌面模式（`server_mode=false`）：`create_window(monitor)` → 返回 `(window, api)`；pywebview 自动调用 `api.set_window`
3. 服务端模式（`server_mode=true`）：`create_api(monitor)` → `run_server(api, settings)`

## 构建（scripts/build.py）

`python scripts/build.py` 提供子命令（`build`/`run` 等），PyInstaller 配置见 `MoMoitor.spec`（onedir、`console=False`、`uac_admin=False`）。前端数据经 `_collect_web` 收集（排除用户壁纸 `bg/` 与系统壁纸副本）。