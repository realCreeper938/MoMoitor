# 公共工具

## common（momoitor/common.py）

| 函数 | 说明 |
|---|---|
| `run_hidden(command, *, timeout=None, capture_output=True, **kwargs)` -> CompletedProcess | `subprocess.run` 的封装，隐藏控制台：`STARTUPINFO SW_HIDE` + `STARTF_USESHOWWINDOW` + `CREATE_NO_WINDOW`（可用性自动判断）。幂等使用于 schtasks / powershell / netstat / where 等 |
| `http_get(url, *, timeout=10, headers=None, **kwargs)` -> Response | `requests.get`，自动附带浏览器 UA（`HTTP_USER_AGENT`），其余参数透传 |

## services/db.py

| 函数 | 说明 |
|---|---|
| `get_conn(db_path, timeout=5.0)` -> contextmanager | 上下文管理器，提交异常时回滚并关闭连接；自动 `PRAGMA journal_mode=WAL` |
| `init_db(db_path, schema)` -> bool | 建父目录、建库、执行建表 SQL |

使用者：`traffic.py`（`data/traffic.db`）、`lyrics.py`（`data/lyrics.db`）。

## services/cache.py

`TTLCache` 线程安全（内部 `threading.Lock`）TTL 缓存。

| 方法 | 语义 |
|---|---|
| `get(key, ttl)` -> (value, hit) | 未命中 `(None, False)`；过期 `(value, False)`（不清除，可作兜底）；新鲜 `(value, True)`；`ttl=None` 永不过期 |
| `set(key, value)` | 写入 |
| `clear()` | 清空 |
| `__len__()` | 条目数 |

使用者：`services/weather.py`（端点缓存）。