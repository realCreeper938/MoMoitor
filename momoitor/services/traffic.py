"""流量记录服务 - 记录每天上传/下载的总流量。

主要方法:
- TrafficService: 流量记录服务类
  - start(): 启动后台记录线程
  - stop(): 停止后台记录线程
  - get_today(): 获取今日流量 {up, down}
  - get_month(year, month): 获取某月每日流量数据
  - get_top_processes(): 获取消耗流量最多的程序

数据存储:
- ./data/traffic.db: SQLite 数据库，包含 daily_traffic 和 proc_cache 两张表
"""

import os
import sqlite3
import time
import threading
from collections import defaultdict
from contextlib import contextmanager

import psutil
from loguru import logger

from momoitor.config import DATA_DIR

DB_PATH = os.path.join(DATA_DIR, "traffic.db")
POLL_INTERVAL = 30  # 每30秒记录一次
SAVE_INTERVAL = 60  # 每60秒持久化一次


class TrafficService:
    def __init__(self):
        self._thread = None
        self._running = False
        self._lock = threading.Lock()

        # 当前累计的上/下行流量（从psutil获取）
        self._prev_bytes_sent = 0
        self._prev_bytes_recv = 0
        self._prev_time = 0.0

        # 当前日期的累计（内存缓存，避免频繁读DB）
        self._today_up = 0
        self._today_down = 0
        self._current_date = ""

        # 进程流量采样缓存（内存）
        self._proc_samples = defaultdict(lambda: {"up": 0, "down": 0, "name": ""})

        self._init_db()
        self._load_today()

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
                    CREATE TABLE IF NOT EXISTS daily_traffic (
                        date TEXT PRIMARY KEY,
                        up INTEGER NOT NULL DEFAULT 0,
                        down INTEGER NOT NULL DEFAULT 0
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS proc_cache (
                        pid INTEGER PRIMARY KEY,
                        name TEXT NOT NULL DEFAULT '',
                        up INTEGER NOT NULL DEFAULT 0,
                        down INTEGER NOT NULL DEFAULT 0,
                        updated_at REAL NOT NULL
                    )
                """)
                conn.commit()
                logger.info("SQLite traffic DB initialized")
        except Exception as e:
            logger.warning("Failed to init traffic DB: {}", e)

    def _load_today(self):
        """从DB加载今日流量到内存缓存。"""
        self._current_date = self._today_str()
        try:
            with self._connect() as conn:
                cur = conn.execute(
                    "SELECT up, down FROM daily_traffic WHERE date = ?",
                    (self._current_date,)
                )
                row = cur.fetchone()
                if row:
                    self._today_up = row[0]
                    self._today_down = row[1]
                else:
                    self._today_up = 0
                    self._today_down = 0
        except Exception as e:
            logger.warning("Failed to load today's traffic: {}", e)
            self._today_up = 0
            self._today_down = 0

        # 初始化psutil计数器
        try:
            net = psutil.net_io_counters()
            self._prev_bytes_sent = net.bytes_sent
            self._prev_bytes_recv = net.bytes_recv
            self._prev_time = time.time()
        except Exception:
            self._prev_bytes_sent = 0
            self._prev_bytes_recv = 0
            self._prev_time = time.time()

    def _save_daily(self):
        """将今日流量写入 SQLite。"""
        try:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO daily_traffic (date, up, down) VALUES (?, ?, ?)",
                    (self._current_date, self._today_up, self._today_down)
                )
                conn.commit()
        except Exception as e:
            logger.warning("Failed to save daily traffic: {}", e)

    def _save_proc_cache(self):
        """将进程缓存写入 SQLite。"""
        try:
            with self._connect() as conn:
                now = time.time()
                for pid, data in self._proc_samples.items():
                    conn.execute(
                        "INSERT OR REPLACE INTO proc_cache (pid, name, up, down, updated_at) VALUES (?, ?, ?, ?, ?)",
                        (pid, data["name"], int(data["up"]), int(data["down"]), now)
                    )
                conn.commit()
        except Exception as e:
            logger.warning("Failed to save proc cache: {}", e)

    @staticmethod
    def _today_str():
        now = time.localtime()
        return f"{now.tm_year}-{now.tm_mon:02d}-{now.tm_mday:02d}"

    def _record_cycle(self):
        """记录周期：计算网络流量增量并累加到当日。"""
        try:
            curr = psutil.net_io_counters()
            now = time.time()

            # 检测日期变更
            today = self._today_str()
            if today != self._current_date:
                with self._lock:
                    # 保存旧日期的数据
                    self._save_daily()
                    # 切换到新日期
                    self._current_date = today
                    self._load_today()
                # 重置psutil基线
                self._prev_bytes_sent = curr.bytes_sent
                self._prev_bytes_recv = curr.bytes_recv
                self._prev_time = now
                return

            # 计算增量
            dt = max(now - self._prev_time, 0.1)
            if dt > 300:  # 超过5分钟未采样，重置基线
                self._prev_bytes_sent = curr.bytes_sent
                self._prev_bytes_recv = curr.bytes_recv
                self._prev_time = now
                return

            up_delta = max(0, curr.bytes_sent - self._prev_bytes_sent)
            down_delta = max(0, curr.bytes_recv - self._prev_bytes_recv)

            self._prev_bytes_sent = curr.bytes_sent
            self._prev_bytes_recv = curr.bytes_recv
            self._prev_time = now

            # 确保增量合理（如果网卡重置或计数溢出，跳过）
            if up_delta > 100 * 1024 * 1024 * dt:  # 超过100MB/s
                logger.debug("Traffic up delta too large ({}B), skipping", up_delta)
                return
            if down_delta > 100 * 1024 * 1024 * dt:
                logger.debug("Traffic down delta too large ({}B), skipping", down_delta)
                return

            with self._lock:
                self._today_up += up_delta
                self._today_down += down_delta
        except Exception as e:
            logger.warning("Traffic record error: {}", e)

    def _sample_processes(self):
        """采样当前有网络连接的进程，估算流量消耗程序。"""
        try:
            conns = psutil.net_connections()
            pid_conns = defaultdict(int)
            for conn in conns:
                if conn.pid and conn.pid > 0:
                    pid_conns[conn.pid] += 1

            # 更新进程缓存
            with self._lock:
                # 按连接数排序，取前10个
                sorted_pids = sorted(pid_conns.items(), key=lambda x: -x[1])[:10]
                for pid, count in sorted_pids:
                    try:
                        p = psutil.Process(pid)
                        name = p.name() or "unknown"
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
                    if pid in self._proc_samples:
                        old = self._proc_samples[pid]
                        old["name"] = name
                        # 衰减旧值，加上当前连接数作为权重
                        old["up"] = old["up"] * 0.7 + count * 1024
                        old["down"] = old["down"] * 0.7 + count * 1024
                    else:
                        self._proc_samples[pid] = {
                            "up": count * 1024,
                            "down": count * 1024,
                            "name": name,
                        }

                # 写入 SQLite
                self._save_proc_cache()
        except Exception as e:
            logger.debug("Process sampling error: {}", e)

    def _run(self):
        """后台线程主循环。"""
        save_counter = 0
        sample_counter = 0
        while self._running:
            self._record_cycle()

            save_counter += POLL_INTERVAL
            sample_counter += POLL_INTERVAL
            if save_counter >= SAVE_INTERVAL:
                self._save_daily()
                save_counter = 0

            # 每2分钟采样一次进程
            if sample_counter >= 120:
                self._sample_processes()
                sample_counter = 0

            time.sleep(POLL_INTERVAL)

    def start(self):
        """启动后台记录线程。"""
        if self._thread and self._thread.is_alive():
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="traffic-recorder")
        self._thread.start()
        logger.info("Traffic service started")

    def stop(self):
        """停止后台记录线程并保存数据。"""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
        self._save_daily()
        logger.info("Traffic service stopped")

    def get_today(self) -> dict:
        """获取今日流量数据。"""
        with self._lock:
            return {
                "up": self._today_up,
                "down": self._today_down,
                "date": self._current_date,
            }

    def get_month(self, year: int, month: int) -> dict:
        """获取某月每日流量数据。

        返回:
            { "YYYY-MM-DD": { "up": int, "down": int }, ... }
        """
        prefix = f"{year}-{month:02d}"
        result = {}
        try:
            with self._connect() as conn:
                cur = conn.execute(
                    "SELECT date, up, down FROM daily_traffic WHERE date LIKE ? || '%'",
                    (prefix,)
                )
                for row in cur:
                    result[row[0]] = {"up": row[1], "down": row[2]}
        except Exception as e:
            logger.warning("Failed to query monthly traffic: {}", e)
        return result

    def get_top_processes(self, limit: int = 5) -> list:
        """获取消耗流量最多的程序（按总流量估算排序）。

        返回:
            [{ "name": str, "up": int, "down": int, "total": int }, ...]
        """
        processes = []
        try:
            with self._connect() as conn:
                cur = conn.execute(
                    "SELECT name, up, down FROM proc_cache ORDER BY (up + down) DESC LIMIT ?",
                    (limit,)
                )
                for row in cur:
                    total = row[1] + row[2]
                    processes.append({
                        "name": row[0],
                        "up": row[1],
                        "down": row[2],
                        "total": total,
                    })
        except Exception as e:
            logger.warning("Failed to query top processes: {}", e)
        return processes