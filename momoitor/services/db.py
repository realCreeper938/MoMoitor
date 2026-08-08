"""共享 SQLite 工具 —— 统一连接管理与建表初始化。

多个服务（traffic、lyrics）都要读写各自的 .db 文件：
- get_conn(db_path): 获取 SQLite 连接的上下文管理器
- init_db(db_path, schema): 创建父目录、启用 WAL、执行建表语句
"""

import os
import sqlite3
from contextlib import contextmanager

from loguru import logger


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