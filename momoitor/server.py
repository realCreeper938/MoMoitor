"""HTTP 服务器后端 —— 无需 pywebview 即可提供 Web UI 与 JSON API。

主要方法:
- ServerBackend: HTTP 服务器后端，处理静态文件、API 路由和 BasicAuth
  - start(): 启动 HTTP 服务器（阻塞）
  - stop(): 停止服务器
  - _handle_api(method, args): 调用 Api 对应方法

主要变量:
- WEB_DIR: 前端 web 文件目录
"""

import base64
import inspect
import json
import mimetypes
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

from loguru import logger

from momoitor.config import WEB_DIR

# 静态文件扩展名 -> MIME 类型补全
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("image/webp", ".webp")


class ServerBackend:
    """HTTP 服务器后端，提供 web UI 和 JSON API。"""

    def __init__(self, api, host: str, port: int, auth_enabled: bool, auth_user: str, auth_pass: str):
        self._api = api
        self._host = host
        self._port = port
        self._auth_enabled = auth_enabled
        self._auth_user = auth_user
        self._auth_pass = auth_pass
        self._server: ThreadingHTTPServer | None = None
        self._stop_flag = threading.Event()

    def start(self):
        host = self._host or "0.0.0.0"
        port = int(self._port or 20622)
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                logger.debug("[HTTP] {} - {}", self.address_string(), fmt % args)

            def _check_auth(self):
                if not backend._auth_enabled:
                    return True
                expected = base64.b64encode(
                    f"{backend._auth_user}:{backend._auth_pass}".encode("utf-8")
                ).decode("ascii")
                hdr = self.headers.get("Authorization", "")
                if hdr.startswith("Basic "):
                    if hdr[6:] == expected:
                        return True
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="MoMoitor"')
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write("需要认证".encode("utf-8"))
                return False

            def do_GET(self):
                if not self._check_auth():
                    return
                path = unquote(self.path.split("?", 1)[0])
                # 健康检查端点
                if path == "/api/health":
                    self._json({"ok": True})
                    return
                # 默认指向 index.html
                if path == "/" or path == "":
                    path = "/index.html"
                # 防止路径穿越
                rel = path.lstrip("/")
                fs_path = os.path.normpath(os.path.join(WEB_DIR, rel))
                if not fs_path.startswith(WEB_DIR) or not os.path.isfile(fs_path):
                    self.send_response(404)
                    self.end_headers()
                    return
                ctype, _ = mimetypes.guess_type(fs_path)
                try:
                    with open(fs_path, "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    if ctype:
                        self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError as e:
                    logger.warning("读取静态文件失败 {}: {}", fs_path, e)
                    self.send_response(500)
                    self.end_headers()

            def do_POST(self):
                if not self._check_auth():
                    return
                path = unquote(self.path.split("?", 1)[0])
                if not path.startswith("/api/"):
                    self.send_response(404)
                    self.end_headers()
                    return
                method = path[5:]
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length > 0 else b""
                try:
                    args = json.loads(raw.decode("utf-8")) if raw else []
                    if not isinstance(args, list):
                        args = [args]
                except (json.JSONDecodeError, UnicodeDecodeError):
                    self._json({"error": "invalid json body"}, status=400)
                    return
                try:
                    fn = getattr(backend._api, method, None)
                    if fn is None or method.startswith("_"):
                        self._json({"error": f"unknown method: {method}"}, status=404)
                        return
                    result = fn(*args)
                    if inspect.isawaitable(result):
                        import asyncio
                        try:
                            loop = asyncio.get_event_loop()
                        except RuntimeError:
                            loop = asyncio.new_event_loop()
                            asyncio.set_event_loop(loop)
                        if loop.is_closed():
                            loop = asyncio.new_event_loop()
                            asyncio.set_event_loop(loop)
                        result = loop.run_until_complete(result)
                    self._json(result)
                except Exception as e:
                    logger.exception("API 调用 {} 失败", method)
                    self._json({"error": str(e)}, status=500)

            def _json(self, payload, status=200):
                body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = ThreadingHTTPServer((host, port), Handler)
        logger.info("服务端模式启动: http://{}:{}", host, port)
        if self._auth_enabled:
            logger.info("BasicAuth 已启用, 用户: {}", self._auth_user)
        try:
            self._server.serve_forever()
        finally:
            self._stop_flag.set()
            logger.info("服务端已停止")

    def stop(self):
        if self._server:
            threading.Thread(target=self._server.shutdown, daemon=True).start()


def run_server(api, settings: dict):
    """根据设置启动 HTTP 服务器（阻塞）。返回后端实例供外部管理。"""
    backend = ServerBackend(
        api,
        host=settings.get("server_host", "0.0.0.0"),
        port=int(settings.get("server_port", 20622)),
        auth_enabled=bool(settings.get("server_auth_enabled", False)),
        auth_user=settings.get("server_auth_user", ""),
        auth_pass=settings.get("server_auth_pass", ""),
    )
    api.set_server_backend(backend)
    backend.start()
    return backend
