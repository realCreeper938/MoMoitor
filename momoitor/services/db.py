"""共享 SQLite 工具 —— 统一连接管理、建表初始化、DB 清单与在线快照。

多个服务（traffic、lyrics）都要读写各自的 .db 文件：
- LYRICS_DB_PATH / TRAFFIC_DB_PATH / DB_PATHS: 数据库文件清单（单一来源，
  备份等服务据此枚举，避免反向依赖各业务服务）
- get_conn(db_path): 获取 SQLite 连接的上下文管理器
- init_db(db_path, schema): 创建父目录、启用 WAL、执行建表语句
- snapshot_db(db_path): 在线备份 API 生成一致性快照字节
"""

import os
import sqlite3
import tempfile
from contextlib import contextmanager

from loguru import logger

from momoitor.config import DATA_DIR

LYRICS_DB_PATH = os.path.join(DATA_DIR, "lyrics.db")
TRAFFIC_DB_PATH = os.path.join(DATA_DIR, "traffic.db")
DB_PATHS = (LYRICS_DB_PATH, TRAFFIC_DB_PATH)


@contextmanager
def get_conn(db_path: str, timeout: float = 5.0):
    """返回 SQLite 连接的上下文管理器（自动关闭）。"""
    conn = sqlite3.connect(db_path, timeout=timeout)
    try:
        yield conn
    finally:
        conn.close()


def init_db(db_path: str, schema: str) -> bool:
    """初始化数据库：创建父目录 + 启用 WAL + 执行建表 schema。"""
    try:
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        with get_conn(db_path) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(schema)
            conn.commit()
        logger.info("SQLite DB initialized: {}", db_path)
        return True
    except Exception as e:
        logger.warning("Failed to init DB {}: {}", db_path, e)
        return False


def snapshot_db(db_path: str) -> bytes:
    """用 SQLite 在线备份 API 生成一致性快照字节；失败时回退为直接读取文件。"""
    try:
        src = sqlite3.connect(db_path)
        try:
            fd, tmp = tempfile.mkstemp(suffix=".db")
            try:
                os.close(fd)
                dst = sqlite3.connect(tmp)
                try:
                    src.backup(dst)
                finally:
                    dst.close()
                with open(tmp, "rb") as f:
                    return f.read()
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
        finally:
            src.close()
    except Exception as e:
        logger.warning("SQLite snapshot failed for {}: {}, falling back to raw copy", db_path, e)
        with open(db_path, "rb") as f:
            return f.read()