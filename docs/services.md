# services/ 模块

## autostart

计划任务自启（schtasks + VBScript 中转）。

| 函数 | 说明 |
|---|---|
| `is_enabled()` -> bool | 检查计划任务 "MoMoitor" 是否存在并启用 |
| `enable()` -> bool | 创建计划任务并写入 VBS 启动脚本 |
| `disable()` -> bool | 删除计划任务 |

## background

背景图片管理。虚拟路径前缀：`bg/` = 内置 `web/bg/`，`wp/` = 用户 `data/wallpapers/`。

| 函数 | 说明 |
|---|---|
| `get_bg_list()` -> list | 内置+用户壁纸条目，形如 `bg/xxx.png`、`wp/xxx.png` |
| `resolve_background(image)` -> str | 校验并返回可加载虚拟路径，无效返回 `""` |
| `save_wallpaper(filename, data_url)` -> str | 保存 base64 导入壁纸（重名自动加序号），返回 `wp/` 路径 |
| `delete_wallpaper(vpath)` -> bool | 删除 `wp/` 下用户壁纸；`_system*` 与内置禁止 |
| `get_image_top_color(image)` -> str | 顶部几行平均色 `#rrggbb` |

## brightness

| 函数 | 说明 |
|---|---|
| `adjust_brightness(action, level=None, monitor_index=0)` -> dict | 亮度调节。action: `get/set/up/down`；策略自动回退（WMI → IOCTL `DISPLAY_BRIGHTNESS`），返回 `{"success": bool, ...}` |

## calendar

| 函数/类 | 说明 |
|---|---|
| `get_huangli(year, month, day)` -> dict | cnlunar 黄历（干支/宜忌/节气/生肖…），失败返回 `{"error":...}` |
| `class HolidayService` | 节假日数据（timor.tech API，按年 TTL 缓存） |
| `HolidayService.get_year(year)` -> dict | `{"MM-DD": {"holiday": bool, "name": str, ...}}` |

## fps

RTSS 共享内存读取前台 FPS，后台线程轮询。

| 函数 | 说明 |
|---|---|
| `start()` / `stop()` | 启停轮询线程 |
| `get_current()` -> dict | `{fps, frametime, process, history_fps, low1pct, avg_fps, p99_fps}` |

## hardware

`HardwareService(monitor, settings)` 包装后端监视器：

| 方法 | 说明 |
|---|---|
| `snapshot()` -> dict | `{cpu,gpu,mem,disks,disk_status,net}` |
| `get_hw_names()` / `get_hw_detail()` | 型号 / 详情 |
| `get_gpu_list()` | GPU 列表 |
| `get_backend_info()` -> dict | 后端版本信息 |
| `change_backend(source)` -> bool | `lhm`/`hwinfo` 切换 |
| `get_data_catalog()` -> dict | 自选数据卡片目录：`{sources:[{source,label,groups}]}`，item key 形如 `std:{group}.{field}` / `raw:{ident}` |
| `read_value(source, key)` -> float\|None | 解析某源某 key 的实时值（标准指标取最近快照，原始传感交给后端反查） |
| `close()` | 释放后端资源 |

## lyrics

Meting API 歌词，SQLite 缓存（`data/lyrics.db`，TTL 7 天，过期兜底）。

| 方法 | 说明 |
|---|---|
| `LyricsService(settings_getter)` | `get_lyrics(title, artist="")` -> `{"lines":[{time,text}...]}`；按 `lyrics_process_whitelist` 过滤进程 |
| `invalidate()` | 清缓存 |

## music

WinRT `Windows.Media.Control` 全局媒体会话。

| 函数 | 说明 |
|---|---|
| `get_current()` | 当前媒体 `{available, title, artist, album, cover, is_playing, position, duration, app}` |
| `play_pause()` / `next_track()` / `prev_track()` | 媒体控制 |
| `refresh_cover()` | 重新抓取封面（含自动裁剪透明边） |
| `get_last_player()` | 上次媒体进程信息 |
| `launch_last_player()` | 启动上次媒体程序（路径探测：AUMID → 注册表 → PATH） |
| `start()` / `stop()` | 启停轮询线程 |

## system

| 函数 | 说明 |
|---|---|
| `get_time()` -> str | 当前时间字符串 |
| `clean_memory(deep=False)` -> dict | 回收工作集 |
| `get_sysinfo()` -> dict | 系统信息（版本/启动时间等） |
| `get_top_processes(sort_by="cpu", limit=1)` -> list | 按 cpu/mem 排序的进程 |
| `kill_process(pid)` -> dict | 结束进程 |
| `scan_listening_ports()` -> list | 监听端口（netstat） |

## traffic

流量统计后台线程，SQLite（`data/traffic.db`，`daily_traffic` + `proc_cache` 表）。

| 方法 | 说明 |
|---|---|
| `start()` / `stop()` | 启停采样线程 |
| `get_today()` -> dict | 今日上行/下行/总流量 |
| `get_month(year, month)` -> dict | 月汇总 |
| `get_top_processes(limit=5)` -> list | 进程流量 TOP |

## update

| 函数 | 说明 |
|---|---|
| `check_latest()` -> dict \| None | `{has_update, current_version, latest_version, release_url, published_at, body}`；失败/无仓库返回 `None` |

## volume

| 函数 | 说明 |
|---|---|
| `adjust_volume(action, level=None)` -> dict | pycaw 音量；action: `set/get/up/down/mute/unmute` |

## weather

QWeather（和风）JWT 客户端 + 缓存服务（合并于同一模块）。

客户端函数（签名一致 `(creds)`，creds 为 `_Creds` dataclass：lat/lon/key_id/project_id/private_key）：
`get_now()` / `get_city_name()` / `get_minutely()` / `get_airquality()` / `get_alerts()`。

`WeatherService(get_settings_fn)`：`get_now()`、`get_detail()`（now+minutely）、`get_airquality()`、`get_alerts()`、`get_lunar_time(timezone="Asia/Shanghai")`、`invalidate()`。未配置凭证返回 `{"error":"not_configured"}`（alerts 返回 `[]`）。按端点 TTL 缓存（now/airquality/alerts 600s，lunar 3600s）。

## window

| 函数 | 说明 |
|---|---|
| `minimize(window)` | 最小化 |
| `set_caption(window, enabled)` | 添加/移除 `WS_CAPTION` |
| `move_to_monitor(window, target)` -> bool | 移动并调整窗口（`target` 为设备 ID/路径或序号；失败重试 3 次） |
| `display_target(display)` | 从 `display` 分组提取目标显示器身份（`monitor_id` 优先，回退序号） |
| `find_display(target, monitors)` -> `(monitor\|None, matched)` | 解析目标身份为当前枚举中的一块屏 |
| `get_monitors()` -> list | 显示器 `{x,y,width,height,work_*,name,device,id,primary}` |
| `get_idle_time()` -> float | 系统空闲秒数（`GetLastInputInfo`） |