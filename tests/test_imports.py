"""最小冒烟测试：所有模块可导入、版本号存在。"""

import importlib
import re


def test_package_imports():
    for name in [
        "momoitor.config",
        "momoitor.api",
        "momoitor.server",
        "momoitor.main",
        "momoitor.fps",
        "momoitor.music",
        "momoitor.weather",
        "momoitor.backends",
        "momoitor.backends.base",
        "momoitor.services",
        "momoitor.services.hardware",
        "momoitor.services.background",
        "momoitor.services.media",
        "momoitor.services.system",
        "momoitor.services.window",
        "momoitor.services.calendar",
        "momoitor.services.weather",
        "momoitor.services.traffic",
    ]:
        importlib.import_module(name)


def test_version_format():
    from momoitor.config import APP_VERSION

    assert re.match(r"^\d+\.\d+\.\d+$", APP_VERSION)


def test_data_dir_resolved():
    from momoitor.config import DATA_DIR

    assert DATA_DIR
