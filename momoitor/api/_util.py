"""API 层装饰器 —— 消灭 JS 桥方法里重复的开关判断与异常兜底样板。"""

import functools

from loguru import logger


def feature_gated(toggle: str, disabled):
    """feature_toggles 开关未开启时直接返回 disabled 值。

    toggle 为 self._feature_on() 的键名；disabled 为关闭时固定返回值
    （仅作 JSON 序列化输出，不会被修改）。
    """

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(self, *args, **kwargs):
            if not self._feature_on(toggle):
                return disabled
            return fn(self, *args, **kwargs)

        return wrapper

    return deco


def safe(label: str, fallback, include_error: bool = False):
    """异常兜底：方法抛错时记 warning 并返回 fallback。

    include_error=True 且 fallback 为 dict 时，合并 {"error": str(e)}
    后返回（供前端展示失败原因）。fallback 仅被序列化、不被修改。
    """

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(self, *args, **kwargs):
            try:
                return fn(self, *args, **kwargs)
            except Exception as e:
                logger.warning("{} failed: {}", label, e)
                if include_error and isinstance(fallback, dict):
                    return {**fallback, "error": str(e)}
                return fallback

        return wrapper

    return deco
