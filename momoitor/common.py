"""跨模块可复用的公共工具，收敛项目中重复出现的样板代码。

- run_hidden: 隐藏控制台窗口运行外部命令（Windows）
- HTTP_USER_AGENT / http_get: 统一 HTTP 请求（浏览器 UA + 超时）

用法示例:
    from momoitor.common import run_hidden, http_get

    r = run_hidden(["schtasks", "/query", "/tn", "MoMoitor"], text=True)
    resp = http_get("https://example.com/api")
"""

import subprocess

import requests

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