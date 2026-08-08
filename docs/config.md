# 路径常量与配置（momoitor/config.py）

## 路径常量

| 常量 | 开发模式 | 打包（frozen） |
|---|---|---|
| `PROJECT_ROOT` | 仓库根目录 | `sys.executable` 所在目录 |
| `BASE_DIR` | `momoitor/` | `sys._MEIPASS` |
| `DATA_DIR` | `<root>/data` | `%LOCALAPPDATA%/MoMoitor` |
| `WEB_DIR` | `BASE_DIR/web` | 同左 |
| `LIB_DIR` | `BASE_DIR/libs` | 同左 |
| `WALLPAPERS_DIR` | `DATA_DIR/wallpapers` | 同左 |
| `SETTINGS_FILE` | `DATA_DIR/settings.json` | 同左 |
| `APP_VERSION` | `"0.6.0"` | 同左 |
| `APP_AUTHOR` / `APP_HOMEPAGE` / `APP_GITHUB_REPO` | 应用元信息（关于页/更新检查） | 同左 |

## 函数

| 函数 | 说明 |
|---|---|
| `detect_system_language()` -> "zh"\|"en" | Windows UI 语言探测（含 locale 兜底） |
| `load_settings()` -> dict | 读 settings.json，缺失键用默认值补齐；带进程级缓存 |
| `save_settings(settings)` | 写 settings.json，并同步缓存 |
| `has_weather_creds(s)` -> bool | `weather_key_id/project_id/private_key` 是否齐全 |

## settings.json 键

| 键 | 默认 | 说明 |
|---|---|---|
| `language` | 系统语言 | 界面语言 zh/en |
| `refresh_interval` | 1000 | 刷新间隔 ms |
| `padding` | 60 | 网格内边距 |
| `font_size` | 100 | 时钟字号 |
| `fullscreen` | false | 全屏 |
| `show_hw_names` | false | 显示硬件型号 |
| `monitor` / `gpu_index` | 0 / 0 | 目标显示器 / GPU |
| `hide_when_monitor_missing` | false | 显示器缺失时隐藏 |
| `colorscheme` | gruvbox | 配色方案 |
| `hover_highlight` | true | 悬停高亮 |
| `clock_24h` / `clock_show_seconds` | true / true | 时钟 24 小时制 / 显示秒 |
| `weather_lat` / `weather_lon` | 39.92 / 116.41 | 天气坐标 |
| `weather_key_id` / `weather_project_id` / `weather_private_key` | "" | QWeather JWT 凭证 |
| `data_source` | lhm | 后端：lhm / hwinfo |
| `autostart` | false | 开机自启 |
| `clock_bg_image` / `clock_bg_opacity` / `clock_bg_blur` / `clock_bg_gradient` / `clock_bg_fit` / `clock_bg_offset_x` / `clock_bg_offset_y` | "" / 80 / 0 / true / fit / 50 / 50 | 时钟背景样式 |
| `font_ui` / `font_data` / `font_clock` | 见默认值 | 界面点击字体 |
| `layout` | 见默认值 | 卡片网格：`{col,row,span,hidden}` |
| `feature_toggles` | 见默认值 | 功能开关（见下） |
| `server_mode` / `server_host` / `server_port` / `server_auth_enabled` / `server_auth_user` / `server_auth_pass` | false / 0.0.0.0 / 20622 / false / "" / "" | HTTP 服务端模式 |
| `hint_dismissed` | false | 首启提示 |
| `update_check_enabled` | true | 检查更新 |
| `meting_api_base` | "" | Meting API 地址，空即关闭歌词 |
| `lyrics_process_whitelist` | 见默认值 | 获取歌词的进程白名单（逗号分隔） |
| `debug_logs` / `debug` | false / false | 日志级别 / pywebview 调试模式 |
| `auto_launch_music_player` | false | 未播放时点击播放自动启动上次播放进程 |

## DEFAULT_SETTINGS.feature_toggles

`calendar, top_process, sysinfo, traffic, clock_bg, top_control`（默认全开）