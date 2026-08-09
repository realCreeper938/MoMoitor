"""版本更新检测 —— 通过 GitHub API 查询最新 Release 并比对版本号。"""

import re

import requests
from loguru import logger

from momoitor.config import APP_VERSION, APP_GITHUB_REPO


def _parse_version(v: str):
    """把 "v0.2.7" / "0.2.7" 解析成可比较的元组 (0, 2, 7)。

    数字段转为 int；非数字段忽略（返回 None 交由调用方决定）。"""
    cleaned = str(v or "").strip().lstrip("vV")
    parts = []
    for seg in re.split(r"[._-]", cleaned):
        if seg.isdigit():
            parts.append(int(seg))
        else:
            # 后缀如 "rc1"/"beta" 截断，仅比较其前的数字部分
            break
    return tuple(parts) if parts else None


def check_latest():
    """查询 GitHub 最新 Release 并与本地版本比对。

    返回 dict：
        has_update    bool     是否存在更新
        current_version str    本地版本号
        latest_version  str    最新 Release 的 tag_name
        release_url    str     Release 页面地址
        published_at   str     发布时间（ISO 8601）
        body           str     更新日志（Markdown）
    请求失败或未配置仓库时返回 None。"""
    if not APP_GITHUB_REPO:
        return None
    url = "https://api.github.com/repos/{}/releases/latest".format(APP_GITHUB_REPO)
    try:
        resp = requests.get(url, timeout=8)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.warning("update check failed: {}", e)
        return None

    tag = str(data.get("tag_name", "") or "")
    latest_parsed = _parse_version(tag)
    current_parsed = _parse_version(APP_VERSION)
    has_update = False
    if latest_parsed and current_parsed:
        has_update = latest_parsed > current_parsed

    return {
        "has_update": has_update,
        "current_version": APP_VERSION,
        "latest_version": tag or str(data.get("name", "")),
        "release_url": str(data.get("html_url", "") or ""),
        "published_at": str(data.get("published_at", "") or ""),
        "body": str(data.get("body", "") or ""),
    }
