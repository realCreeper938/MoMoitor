"""最小冒烟测试：所有模块可导入、版本号存在。"""

import importlib
import re


def test_package_imports():
    for name in [
        "momoitor.config",
        "momoitor.plugins",
        "momoitor.plugins.base",
        "momoitor.plugins.manager",
        "momoitor.plugins.monitor",
        "momoitor.api",
        "momoitor.server",
        "momoitor.main",
        "momoitor.backends",
        "momoitor.backends.base",
        "momoitor.services",
        "momoitor.services.fps",
        "momoitor.services.music",
        "momoitor.services.hardware",
        "momoitor.services.background",
        "momoitor.services.system",
        "momoitor.services.proclist",
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


def test_layout_grid_defaults():
    from momoitor.config import DEFAULT_SETTINGS

    assert DEFAULT_SETTINGS["layout"]["rows"] == 5
    assert DEFAULT_SETTINGS["layout"]["cols"] == 2
