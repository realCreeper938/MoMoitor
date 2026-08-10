# 硬件监控后端（momoitor/backends/）

## BaseMonitor（协议，backends/base.py）

`BaseMonitor(abc.ABC)` 定义快照协议，实现类可继承自带工具方法：

| 方法 | 说明 |
|---|---|
| `_run_wmic(args, timeout=3)` | 隐藏窗口执行 wmic |
| `_run_powershell(script, timeout=5)` | 隐藏窗口执行 PowerShell |
| `_get_disk_partitions()` | psutil 磁盘分区（10s 缓存） |
| `get_hw_names()` -> dict | 硬件型号 |
| `get_hw_detail(gpu_index=None)` -> dict | 硬件详情 |
| `get_network()` / `_get_network_name()` / `_resolve_net_hw_name(iface)` | 网络快照/活跃网卡/网卡型号 |
| `get_backend_info()` -> dict | 后端标识（名称/版本） |
| `close()` | 释放资源 |

## LHMMonitor（backends/lhm.py）

基于 LibreHardwareMonitor（`momoitor/libs` 内置 DLL，pythonnet `clr` 加载，需管理员权限）。

- 优先级选 GPU：禁用/空名芯片排除，独立 GPU 优先
- 温度=最大值、负载=最大值、电压=最大值聚合（`_agg`）
- 额外提供 `get_gpu_list()`、`get_hw_detail()`（CPU/GPU/内存型号、频率、通道等）

## HWiNFOMonitor（backends/hwinfo.py）

读取 HWiNFO64 共享内存（需 HWiNFO 已开启 `Shared Memory Support`）。

- 二进制解析工具：`_null_terminated(raw)`、`_read_float64(data, offset)`、`_read_uint32(data, offset)`
- `snapshot(gpu_index=None)` 按读数标签关键词提取 CPU/GPU/内存/磁盘
- 磁盘空间用 `psutil.disk_partitions` 补齐

## 创建方式

`api.create_monitor()` 按设置 `data_source` 选择（默认 `lhm`）；`HardwareService.change_backend()` 可运行时切换。