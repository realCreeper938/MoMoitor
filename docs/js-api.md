# JS 桥接 Api（momoitor/api/）

`Api` 由四个 mixin 组合：`ApiCore + HardwareMixin + WeatherMixin + MediaMixin`（见 `api/__init__.py`）。pywebview 的 `js_api` 与 HTTP 服务端模式均以 `Api` 实例上的方法名为接口（server.py 用 `getattr(api, method)` 分发）。

## 工厂函数

| 函数 | 说明 |
|---|---|
| `create_monitor()` | 按设置 `data_source` 创建监视器后端（`lhm` 默认 / `hwinfo`），返回 `BaseMonitor` 实例 |
| `create_window(monitor)` | 创建 pywebview 窗口并绑定 `Api`，启动 fps/music 采样线程，返回 `(window, api)` |
| `create_api(monitor)` | 服务端模式：仅创建 `Api` 实例并启动采样，不创建窗口 |

## 通用

| 方法 | 说明 |
|---|---|
| `set_window(window)` | 绑定窗口引用、去除窗口阴影、启动流量统计线程（pywebview 自动调用） |
| `set_server_backend(backend)` | 注入 `ServerBackend` 用于 `close_app` 时停服 |
| `js_log(level, message)` | 前端日志转发到 loguru |
| `get_feature_toggles()` | 返回 `feature_toggles` 字典 |
| `get_settings()` / `save_settings(settings)` | 读写设置；保存后使天气缓存失效并按需移动窗口/切换全屏 |
| `get_app_info()` | `{program, author, homepage, github_repo, python, pywebview, backend}` |
| `check_for_updates()` | `update_check_enabled` 为假时返回 `None`，否则见 `services.update.check_latest` |
| `get_server_info()` | `{settings_file, host, port, urls}`（含 LAN IP 提示） |
| `close_app()` | 停止采样线程、关闭监视器、销毁窗口、停服 |
| `dismiss_first_launch_hint()` | 持久化 `hint_dismissed=true` |

## 硬件 / 系统（HardwareMixin）

| 方法 | 开关 | 说明 |
|---|---|---|
| `get_data()` | — | 硬件快照 `{cpu,gpu,mem,disks,disk_status,net}` |
| `get_hw_names()` | — | 硬件型号 |
| `get_gpu_list()` | — | GPU 列表 |
| `get_hw_detail()` | — | 硬件详情 |
| `get_hardware_info()` | — | 快照+详情拼成的多行文本 `{success, info}` |
| `change_backend(source)` | — | 切换后端 |
| `get_time()` | — | 服务器时间字符串 |
| `get_sysinfo()` | `sysinfo` | 系统信息；关闭返回 `{}` |
| `get_idle_time()` | — | 系统空闲秒数 |
| `get_top_processes(sort_by, limit)` | `top_process` | 进程排序（默认 cpu，limit=1）；关闭返回 `[]` |
| `kill_process(pid)` | `top_process` | 结束进程；关闭返回 `{"error":"disabled"}` |
| `get_listening_ports()` | — | 监听端口列表 |
| `clean_memory(deep)` | — | 回收工作集 |
| `open_taskmgr()` | — | 启动任务管理器 |
| `open_external(url)` | — | 浏览器打开 http/https 链接；非法 URL 返回 `False` |

## 天气 / 日历（WeatherMixin）

| 方法 | 开关 | 说明 |
|---|---|---|
| `get_weather()` / `get_weather_detail()` / `get_airquality()` / `get_alerts()` | `weather` | 见 `services.weather.WeatherService`；关闭返回 `{"error":"disabled"}`（alerts 返回 `[]`） |
| `get_weather_info()` | `weather` | `{weather, air_quality}` 合并 |
| `get_lunar_time(timezone="Asia/Shanghai")` | `weather` | 农历时间 |
| `get_huangli(year, month, day)` | `calendar` | 黄历；关闭返回 `{"error":"disabled"}` |
| `get_holiday(year)` | `calendar` | 全年节假日；关闭返回 `{}` |

## 媒体 / 内容（MediaMixin）

| 方法 | 开关 | 说明 |
|---|---|---|
| `get_music()` | `music` | 当前媒体；失败返回 `{"available":False,"error":...}` |
| `get_lyrics(title, artist="")` | `meting_api_base` 非空 | 歌词 `{"lines":[...]}`；未配置返回空 |
| `get_fps()` | `fps` | `{fps, frametime, process, history_fps, low1pct, avg_fps, p99_fps}`；关闭全 0 |
| `get_last_player()` / `launch_last_player()` | — | 上次播放的媒体程序 |
| `music_play_pause()` / `music_refresh_cover()` / `music_next()` / `music_prev()` | `music` | 媒体控制；关闭返回 `{"error":"disabled"}` |
| `adjust_volume(action, level=None)` | — | pycaw 音量；action: set/get/up/down/mute/unmute |
| `adjust_brightness(action, level=None, monitor_index=None)` | — | 亮度；monitor_index 缺省取设置 `monitor` |
| `get_traffic_today()` / `get_traffic_month(y,m)` / `get_traffic_top_processes(limit)` | `traffic` | 流量统计；关闭返回 `{"error":"disabled"}` |
| `get_bg_list()` | `clock_bg` | 背景列表（`bg/*` 内置、`wp/*` 用户） |
| `resolve_background_image(image)` | `clock_bg` | 解析可加载背景路径 |
| `get_clock_bg_top_color(image)` | `clock_bg` | 图片顶部平均色 `#rrggbb` |
| `get_monet_colors(source="wallpaper", bg_image="")` | — | Material You 配色 |
| `save_wallpaper(filename, data_url)` | `clock_bg` | 保存导入壁纸，返回 `wp/` 路径 |
| `delete_wallpaper(path)` | `clock_bg` | 删除用户壁纸 |

## 窗口 / 生命周期（ApiCore）

| 方法 | 说明 |
|---|---|
| `get_monitors()` | 显示器坐标列表 |
| `move_to_monitor(index)` | 移动窗口到目标显示器 |
| `check_monitor()` | `{available, count}` |
| `set_caption(enabled)` | 添加/移除原生标题栏 |
| `toggle_fullscreen()` | 切换全屏 |
| `minimize_window()` | 最小化 |
| `show_calendar()` / `hide_calendar()` | 通过 `window.evaluate_js` 触发前端日历覆盖层 |
| `get_autostart()` / `set_autostart(enabled)` | 计划任务自启状态/开关 |

## feature_toggles 键

`_feature_on(name)` 未配置时默认开启。实际使用键：`sysinfo, top_process, weather, calendar, traffic, music, fps, clock_bg`。