"""歌词服务 —— 通过 Meting API 获取当前音乐的 LRC 歌词并解析。

主要方法:
- LyricsService类: 歌词获取与解析服务
  - get_lyrics(title, artist): 获取某首歌的歌词行列表 [{time, text}, ...]
  - invalidate(): 清空缓存（保留表结构）

数据来源: Meting API（如 https://meting.spr-aachen.com/api），地址由用户在
「设置 → 数据 → 歌词」中填写。为避免给歌词服务器造成压力，歌词按 曲目|歌手 键
缓存到 SQLite（data/lyrics.db），TTL 7 天；获取失败时回退使用过期缓存。
"""

import os
import re
import sqlite3
import time
from contextlib import contextmanager

import requests
from loguru import logger

from momoitor.config import DATA_DIR

DB_PATH = os.path.join(DATA_DIR, "lyrics.db")
# 歌词缓存永久保留：命中即用，仅完全未命中才请求服务器，避免给歌词服务器造成压力。
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# 匹配形如 [00:09.499] 或 [00:11] 的 LRC 时间戳标签
_LRC_RE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$")


class LyricsService:
    """带 SQLite 磁盘缓存的歌词获取与解析服务。"""

    def __init__(self, settings_getter):
        self._settings_getter = settings_getter
        self._init_db()

    @contextmanager
    def _connect(self):
        """SQLite 连接的上下文管理器。"""
        conn = sqlite3.connect(DB_PATH, timeout=5)
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self):
        """初始化 SQLite 数据库和表结构。"""
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with self._connect() as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS lyrics (
                        key TEXT PRIMARY KEY,
                        lrc TEXT NOT NULL DEFAULT '',
                        updated_at REAL NOT NULL
                    )
                """)
                conn.commit()
                logger.info("SQLite lyrics DB initialized")
        except Exception as e:
            logger.warning("Failed to init lyrics DB: {}", e)

    @staticmethod
    def _parse_lrc(text):
        """把 LRC 文本解析成按时间排序的歌词行列表。

        返回:
            [{"time": float秒, "text": str}, ...]  空文本行与无时间戳行跳过
        """
        lines = []
        for raw in text.splitlines():
            raw = raw.rstrip()
            m = _LRC_RE.match(raw)
            if not m:
                continue
            minutes = int(m.group(1))
            seconds = float(m.group(2))
            content = m.group(3).strip()
            if not content:
                continue
            lines.append({"time": minutes * 60 + seconds, "text": content})
        lines.sort(key=lambda x: x["time"])
        return lines

    def _load_cached(self, key):
        """读取缓存，返回 (lrc_text, updated_at) 或 (None, None)。"""
        try:
            with self._connect() as conn:
                cur = conn.execute(
                    "SELECT lrc, updated_at FROM lyrics WHERE key = ?", (key,)
                )
                row = cur.fetchone()
                if row:
                    return row[0], row[1]
        except Exception as e:
            logger.warning("Failed to load lyrics cache: {}", e)
        return None, None

    def _save_cache(self, key, lrc):
        try:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO lyrics (key, lrc, updated_at) VALUES (?, ?, ?)",
                    (key, lrc, time.time())
                )
                conn.commit()
        except Exception as e:
            logger.warning("Failed to save lyrics cache: {}", e)

    def _base_url(self):
        """返回用户配置的 Meting API 基础地址（仅去尾斜杠），未配置返回空串。

        完全尊重用户输入：填什么就请求什么，不自动补路径。默认关闭歌词。
        """
        base = ""
        try:
            base = (self._settings_getter() or {}).get("meting_api_base", "") or ""
        except Exception:
            pass
        return base.rstrip("/")

    def get_lyrics(self, title, artist=""):
        """获取某首歌的歌词行列表。

        未配置 Meting 地址或获取失败时返回空列表；命中缓存（永久）则直接返回。
        """
        base = self._base_url()
        if not base:
            return []
        title = (title or "").strip()
        if not title:
            return []
        server = "netease"  # 歌词数据源固定为 netease
        key = f"{server}|{title}|{artist}"

        # 1. 命中缓存（永久）则直接返回，不再请求服务器
        cached_lrc, _updated = self._load_cached(key)
        if cached_lrc is not None:
            return self._parse_lrc(cached_lrc)

        # 2. 未命中：从 Meting 拉取
        try:
            lrc = self._fetch_lrc(base, title, artist, server)
            if lrc:
                self._save_cache(key, lrc)
                return self._parse_lrc(lrc)
        except Exception as e:
            logger.warning("Lyrics fetch failed for '{}': {}", title, e)
        return []

    def _fetch_lrc(self, base, title, artist="", server="netease"):
        """搜索歌曲并取第一首的 LRC 文本。搜索关键词用「歌名 - 歌手」以提高准确度。

        返回 "" 表示无结果；任何异常（含空/非 JSON 响应）都归为无结果，不抛出。
        """
        import urllib.parse
        keyword = f"{title} - {artist}".strip(" -") if artist else title
        search_url = base + "?server=" + server + "&type=search&id=" + urllib.parse.quote(keyword)
        try:
            resp = requests.get(search_url, headers={"User-Agent": UA}, timeout=8)
            resp.raise_for_status()
            results = self._as_list(resp)
            if not results:
                return ""
            lrc_url = (results[0] or {}).get("lrc", "") or ""
            if not lrc_url:
                return ""
            lresp = requests.get(lrc_url, headers={"User-Agent": UA}, timeout=8)
            lresp.raise_for_status()
            return lresp.text
        except Exception as e:
            logger.opt(exception=True).debug("Lyrics search/lrc failed for '{}': {}", keyword, e)
            return ""

    @staticmethod
    def _as_list(resp):
        """把搜索响应解析成结果列表。兼容直接数组、以及 {"data": [...]} 包裹的格式。

        空响应 / 非 JSON / 结构不符时返回 []。解析失败会在 debug 日志记录详细错误。
        """
        try:
            data = resp.json()
        except Exception as e:
            logger.opt(exception=True).debug(
                "Lyrics search response is not valid JSON: {}", e)
            return []
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            inner = data.get("data")
            if isinstance(inner, list):
                return inner
            logger.debug("Lyrics search response has unexpected shape: {!r}", data)
            return []
        logger.debug("Lyrics search response is neither list nor dict: {!r}", data)
        return []

    def invalidate(self):
        """清空歌词缓存（保留表结构）。"""
        try:
            with self._connect() as conn:
                conn.execute("DELETE FROM lyrics")
                conn.commit()
        except Exception as e:
            logger.warning("Failed to clear lyrics cache: {}", e)
