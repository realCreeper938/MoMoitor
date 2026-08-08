"""线程安全的 TTL 内存缓存 —— 供天气、节假日等服务复用。

用法:
    cache = TTLCache()
    value, hit = cache.get("now", ttl=600)
    if not hit:
        value = fetch()
        cache.set("now", value)

特点:
- 读写锁；线程安全
- TTL 在 get 时按调用方传入判断（不同 TTL 可共享同一 key）
- 过期的条目不会被主动删除，网络失败时可回退使用过期值
"""

import threading
import time


class TTLCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._data = {}
        self._ts = {}

    def get(self, key, ttl: float):
        """获取条目。

        未命中返回 (None, False)；命中但已过期返回 (value, False)（不删除，便于
        网络失败时回退使用过期值）；命中且未过期返回 (value, True)。
        ttl 单位为秒；为 None 时视为永久不过期。
        """
        now = time.monotonic()
        with self._lock:
            if key in self._data:
                ts = self._ts.get(key)
                if ts is not None and (ttl is None or now - ts < ttl):
                    return self._data[key], True
                return self._data[key], False
        return None, False

    def set(self, key, value):
        with self._lock:
            self._data[key] = value
            self._ts[key] = time.monotonic()

    def clear(self):
        with self._lock:
            self._data.clear()
            self._ts.clear()

    def __len__(self):
        with self._lock:
            return len(self._data)