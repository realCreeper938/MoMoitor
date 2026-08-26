"""跨模块可复用的公共工具，收敛项目中重复出现的样板代码。

- run_hidden: 隐藏控制台窗口运行外部命令（Windows）
- HTTP_USER_AGENT / http_get: 统一 HTTP 请求（浏览器 UA + 超时）
- Poller: 通用后台轮询线程（可中断 sleep、幂等启停）

用法示例:
    from momoitor.common import run_hidden, http_get, Poller

    r = run_hidden(["schtasks", "/query", "/tn", "MoMoitor"], text=True)
    resp = http_get("https://example.com/api")
    poller = Poller("music", 1.0, tick); poller.start()
"""

import subprocess
import threading

import requests
from loguru import logger

HTTP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


def run_hidden(command, *, timeout=None, capture_output=True, **kwargs):
    """在 Windows 下隐藏控制台窗口运行外部命令。

    同时启用 STARTUPINFO(SW_HIDE) 与 CREATE_NO_WINDOW，双保险，
    避免 powershell / schtasks / netstat 等命令行工具闪现窗口。
    参数与返回值和 subprocess.run 一致（超时 / 命令不存在等异常会向上抛出）。
    """
    startupinfo = None
    if hasattr(subprocess, "STARTUPINFO"):
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0  # SW_HIDE
    creationflags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        creationflags = subprocess.CREATE_NO_WINDOW
    return subprocess.run(
        command,
        capture_output=capture_output,
        timeout=timeout,
        startupinfo=startupinfo,
        creationflags=creationflags,
        **kwargs,
    )


def http_get(url, *, timeout=10, headers=None, **kwargs):
    """带浏览器 UA 的 GET 请求，返回 requests.Response。

    统一注入 HTTP_USER_AGENT，避免被节假日 / 歌词等第三方接口拒收。
    """
    h = dict(headers or {})
    h.setdefault("User-Agent", HTTP_USER_AGENT)
    return requests.get(url, headers=h, timeout=timeout, **kwargs)


class Poller:
    """通用后台轮询线程：可中断 sleep、幂等 start/stop、旧线程复用。

    - stop() 通过 Event 立即打断间隔等待，线程在当次 fn 返回后即退出；
      传入 join_timeout 可等待线程真正结束。
    - stop() 后立即 start() 时若旧线程仍在收尾，撤销停止请求并复用旧
      线程，避免重复轮询。
    """

    def __init__(self, name: str, interval: float, fn):
        self._name = name
        self._interval = interval
        self._fn = fn
        self._event = threading.Event()
        self._thread = None

    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.running():
            self._event.clear()
            return
        self._event.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name=self._name)
        self._thread.start()

    def stop(self, join_timeout=None):
        self._event.set()
        if join_timeout and self._thread:
            self._thread.join(timeout=join_timeout)
        self._thread = None

    def _loop(self):
        while not self._event.is_set():
            wait = self._interval
            try:
                r = self._fn()
                # fn 可返回数字作为下一轮间隔，实现按状态调节轮询频率
                if isinstance(r, (int, float)) and r > 0:
                    wait = r
            except Exception as e:
                logger.debug("Poller {}: {}", self._name, e)
            # 可中断 sleep：stop() 后立即返回，不再滞留整个间隔
            self._event.wait(wait)