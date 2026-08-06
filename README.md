# MoMoitor

基于 Python + PyWebview，专为小屏设计的 Windows 系统监视应用。

*注意! 这个项目从头到尾都是由 AI 编写的，是彻头彻尾的 Vibe Coding 的产物，这本身也是一个自用的项目。如果介意，建议不要使用。*

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.10%2B-blue)

## 功能&特性

- **硬件监控**：实时呈现 CPU / GPU / 内存 / 网络 / 磁盘 / 进程等关键指标。
- **双数据后端**：支持 LibreHardwareMonitor 原生接入，或通过 [HWiNFO](https://www.hwinfo.com/) 共享内存读取数据（需自行下载并开启共享内存选项）。
- **时钟与日历**：基础时间显示，日历模块集成农历、黄历、法定节假日及调休安排。
- **天气**：接入和风天气 API，提供实时天气、降水预报、空气质量指数及灾害预警等数据。
- **音乐控制**：获取当前播放媒体信息，可控制播放/暂停、上一首/下一首。
- **主题系统**：内置多套配色方案，并允许自定义时钟区域背景图，满足视觉差异化需求。
- **FPS 监控**：通过 [RTSS](https://www.guru3d.com/download/rtss-rivatuner-statistics-server-download/)，实时读取游戏帧率，附加 1% Low 帧与帧生成延迟数据（需在后台运行 RTSS）。
- **指定显示器**：支持启动时强制绑定至特定显示器，程序启动后自动定位至指定屏幕，适用于多显示环境。
- **低资源占用**：WebView 渲染进程与主进程合计 CPU 占用 < 2%，GPU 占用峰值 ≤ 0.5%，对系统负载影响极小。

## 环境要求

- Windows 10 / 11（x64）
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 通常已内置，Win10 随 Edge 安装）
- .NET Framework 4.8（Win10/11 内置）

**可选安装以下内容**

- [HWiNFO](https://www.hwinfo.com/) 提供 HWiNFO 数据源，相比 LHM 可以显示内存电压，CPU 电压也会显示的更准确。
- [RTSS](https://www.guru3d.com/download/rtss-rivatuner-statistics-server-download/) 显示帧率信息，必须确保 RTSS 在运行才能显示。

## 安装

### Releases

从 [Releases](https://github.com/realCreeper938/MoMoitor/releases) 下载
`MoMoitor-v{version}-win64.zip`，解压后运行 `MoMoitor.exe`。

**建议右键以管理员身份运行，否则可能无法设置开机自启。**

### 从源码运行

首先 Clone 本项目到本地，或者 [Download ZIP](https://github.com/realCreeper938/MoMoitor/archive/refs/heads/main.zip)。

打开一个管理员权限的终端/CMD，运行以下指令:
```bash
pip install -r requirements.txt
python -m momoitor.main        # 启动桌面窗口
```

或者直接打开 `start.bat`。

## 用法

启动程序后，按 `S` 键打开设置。

本程序在小屏幕上使用显示效果最佳 *(尤其是 5.5 寸的，因为 dev 就是专门给这个屏幕设计的)*

若要使用天气功能，需要配置和风天气的密钥。

## 文档

*稍后补充*

## 构建

```bash
pip install -r requirements-dev.txt
python scripts/build.py check       # 语法检查
python scripts/build.py build       # PyInstaller onedir → dist/MoMoitor-v*.zip
python scripts/build.py icon        # 重新生成应用图标
python scripts/build.py run         # 开发模式启动
```

构建产物位于 `dist/`，数据写入 `%LOCALAPPDATA%\MoMoitor`（源码运行时为项目内 `data/`）。

## 许可证

[MIT License](LICENSE)

随包分发的第三方组件（许可文本见 `LICENSES/`）：

| 组件 | 位置 | 许可证 |
|---|---|---|
| LibreHardwareMonitor | `momoitor/libs/` | [MPL-2.0](LICENSES/MPL-2.0.txt)（源码：https://github.com/LibreHardwareMonitor/LibreHardwareMonitor ，未修改分发） |
| JetBrains Maple Mono | `momoitor/web/fonts/` | [OFL-1.1](LICENSES/OFL-1.1.txt) |
| Departure Mono | `momoitor/web/fonts/` | [OFL-1.1](LICENSES/OFL-1.1.txt) |
| IoskeleyMono | `momoitor/web/fonts/` | [OFL-1.1](LICENSES/OFL-1.1.txt) |
| Symbols Nerd Font Mono | `momoitor/web/fonts/` | [MIT](LICENSES/MIT.txt) |
