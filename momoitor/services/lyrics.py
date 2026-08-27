"""歌词服务 —— 通过 Meting API 或 LrcApi 获取 LRC 歌词并解析。

歌词按 数据源|地址|曲目|歌手 键缓存到 SQLite（data/lyrics.db）；
获取失败时回退使用过期缓存。数据源在「设置 → 数据 → 歌词」中选择：
- meting：地址由用户在 music.meting_api_base 填写，留空关闭歌词；
- lrcapi：地址由用户在 lyrics.lrcapi_base 填写，留空使用官方公开 API。
Meting 搜索结果不止一条时，按曲名/歌手与当前播放内容的相似度选取最佳匹配项。
"""

import difflib
import os
import re
import time
import unicodedata

from loguru import logger

from momoitor.common import http_get
from momoitor.services.db import LYRICS_DB_PATH as DB_PATH, get_conn, init_db

# 匹配形如 [00:09.499] 或 [00:11] 的 LRC 时间戳标签
_LRC_RE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$")

# 匹配用的分隔符与噪声字符：歌手名分隔、曲名中的空白/标点差异
_ARTIST_SEP_RE = re.compile(r"[/,、&;；，]+|\bfeat\.?\b|\bft\.?\b", re.IGNORECASE)
_MATCH_NOISE_RE = re.compile(r"[\s\-—–_()（）\[\]【】「」·.!！?？'\"‘’“”~～]+")


def _norm_text(s) -> str:
    """文本归一化：NFKC 折叠全角、casefold 忽略大小写、去空白与标点噪声。"""
    s = unicodedata.normalize("NFKC", str(s or ""))
    return _MATCH_NOISE_RE.sub("", s.casefold())


def _name_tokens(s) -> list:
    """把歌手字段按常见分隔符拆成归一化 token 列表（用于顺序无关比较）。"""
    parts = _ARTIST_SEP_RE.split(unicodedata.normalize("NFKC", str(s or "")))
    tokens = [_norm_text(p) for p in parts]
    return [t for t in tokens if t]


def _sim(a: str, b: str) -> float:
    """字符串相似度 0~1：相等 1.0；互相包含 0.85；其余 difflib 序列相似比。"""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.85
    return difflib.SequenceMatcher(None, a, b).ratio()


def _artist_sim(local: list, remote: list) -> float:
    """歌手集合相似度：本地每个 token 取对端最大相似度求和，除以较大侧 token 数，
    对多出/缺失的歌手按比例扣分，且与歌手排列顺序无关。"""
    if not local or not remote:
        return 0.0
    total = sum(max(_sim(t, rt) for rt in remote) for t in local)
    return total / max(len(local), len(remote))


def pick_best_result(results, title, artist=""):
    """在 Meting 搜索结果中选出与当前播放的曲名/歌手最匹配的一项。

    得分 = 曲名相似度 * 0.7 + 歌手相似度 * 0.3（未提供歌手时仅看曲名）；
    同分保持原有顺序（全部不匹配即回退第一项，与旧行为一致）。
    任一入参异常时返回 {}，由调用方按无结果处理。
    """
    if not isinstance(results, list) or not results:
        return {}
    nt = _norm_text(title)
    la = _name_tokens(artist)
    best_i, best_score = 0, -1.0
    for i, item in enumerate(results):
        info = item if isinstance(item, dict) else {}
        tscore = _sim(nt, _norm_text(info.get("title")))
        ascore = _artist_sim(la, _name_tokens(info.get("author"))) if la else 0.0
        score = tscore * 0.7 + ascore * 0.3
        if score > best_score:
            best_i, best_score = i, score
    best = results[best_i]
    return best if isinstance(best, dict) else {}

_SCHEMA = """
    CREATE TABLE IF NOT EXISTS lyrics (
        key TEXT PRIMARY KEY,
        lrc TEXT NOT NULL DEFAULT '',
        updated_at REAL NOT NULL
    );
"""


class LyricsService:
    """带 SQLite 磁盘缓存的歌词获取与解析服务。"""

    def __init__(self, settings_getter):
        self._settings_getter = settings_getter
        self._init_db()

    def _init_db(self):
        """初始化 SQLite 数据库和表结构。"""
        init_db(DB_PATH, _SCHEMA)

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
            with get_conn(DB_PATH) as conn:
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
            with get_conn(DB_PATH) as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO lyrics (key, lrc, updated_at) VALUES (?, ?, ?)",
                    (key, lrc, time.time())
                )
                conn.commit()
        except Exception as e:
            logger.warning("Failed to save lyrics cache: {}", e)

    def _settings_lyrics(self) -> dict:
        """返回用户配置的 lyrics 分组设置（异常时回退空字典）。"""
        try:
            return (self._settings_getter() or {}).get("lyrics", {}) or {}
        except Exception:
            return {}

    def _source(self) -> str:
        """返回当前歌词数据源：meting / lrcapi；未识别一律回退 meting。"""
        return (self._settings_lyrics().get("source") or "meting")

    def _base_url(self):
        """返回用户配置的 Meting API 基础地址（仅去尾斜杠），未配置返回空串。

        完全尊重用户输入：填什么就请求什么，不自动补路径。Meting 未配置时关闭歌词。
        """
        base = ""
        try:
            base = ((self._settings_getter() or {}).get("music", {}) or {}).get("meting_api_base", "") or ""
        except Exception:
            pass
        return base.rstrip("/")

    def _lrcapi_url(self):
        """返回 LrcApi 歌词地址：用户填写则用之，留空回退官方公开 API。"""
        base = (self._settings_lyrics().get("lrcapi_base") or "").strip().rstrip("/")
        return base or "https://api.lrc.cx/lyrics"

    def is_configured(self) -> bool:
        """当前是否具备可用的歌词数据源。Meting 需配置地址；LrcApi 恒可用（有默认公开 API）。"""
        source = self._source()
        if source == "lrcapi":
            return True
        if source == "meting":
            return bool(self._base_url())
        return False

    def get_lyrics(self, title, artist=""):
        """获取某首歌的歌词行列表。

        按所选数据源获取；未配置地址（仅 Meting 需配置）或获取失败时返回空列表；
        命中缓存（永久）则直接返回。
        """
        source = self._source()
        if source not in ("meting", "lrcapi"):
            return []
        title = (title or "").strip()
        if not title:
            return []
        base = self._base_url() if source == "meting" else self._lrcapi_url()
        if source == "meting" and not base:
            return []
        key = f"{source}|{base}|{title}|{artist}"

        # 1. 命中缓存（永久）则直接返回，不再请求服务器
        cached_lrc, _updated = self._load_cached(key)
        if cached_lrc is not None:
            return self._parse_lrc(cached_lrc)

        # 2. 未命中：按数据源拉取
        try:
            lrc = self._fetch_lrc_by_source(source, base, title, artist)
            if lrc:
                self._save_cache(key, lrc)
                return self._parse_lrc(lrc)
        except Exception as e:
            logger.warning("Lyrics fetch failed for '{}': {}", title, e)
        return []

    def _fetch_lrc_by_source(self, source, base, title, artist=""):
        """按数据源分发：lrcapi 走 LrcApi 直取 LRC 文本，meting 走 Meting 搜索。"""
        if source == "lrcapi":
            return self._fetch_lrc_lrcapi(base, title, artist)
        return self._fetch_lrc(base, title, artist)

    def _fetch_lrc_lrcapi(self, base, title, artist=""):
        """通过 LrcApi 直接获取 LRC 文本：GET {base}?title=..&artist=..。

        返回 "" 表示无结果；任何异常（含非 2xx）都归为无结果，不抛出。
        """
        import urllib.parse
        url = base + "?title=" + urllib.parse.quote(title)
        if artist:
            url += "&artist=" + urllib.parse.quote(artist)
        try:
            resp = http_get(url, timeout=10)
            resp.raise_for_status()
            return resp.text or ""
        except Exception as e:
            logger.opt(exception=True).debug("Lyrics lrcapi fetch failed for '{}': {}", title, e)
            return ""

    def _fetch_lrc(self, base, title, artist="", server="netease"):
        """搜索歌曲并取与播放内容最匹配一首的 LRC 文本。搜索关键词用「歌名 - 歌手」以提高准确度。

        结果多于一条时按 pick_best_result 的相似度评分选取，不再盲取第一项；
        返回 "" 表示无结果；任何异常（含空/非 JSON 响应）都归为无结果，不抛出。
        """
        import urllib.parse
        keyword = f"{title} - {artist}".strip(" -") if artist else title
        search_url = base + "?server=" + server + "&type=search&id=" + urllib.parse.quote(keyword)
        try:
            resp = http_get(search_url, timeout=8)
            resp.raise_for_status()
            results = self._as_list(resp)
            if not results:
                return ""
            best = pick_best_result(results, title, artist)
            lrc_url = (best or {}).get("lrc", "") or ""
            if not lrc_url:
                return ""
            lresp = http_get(lrc_url, timeout=8)
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

    def invalidate(self) -> int:
        """清空歌词缓存（保留表结构），返回删除的条目数；失败返回 0。"""
        try:
            with get_conn(DB_PATH) as conn:
                cur = conn.execute("DELETE FROM lyrics")
                conn.commit()
                n = cur.rowcount or 0
                logger.info("Lyrics cache cleared: {} entries", n)
                return n
        except Exception as e:
            logger.warning("Failed to clear lyrics cache: {}", e)
            return 0
