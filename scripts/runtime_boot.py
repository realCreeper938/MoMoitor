# 运行时引导钩子：尽可能早地建立崩溃可见性。
# 该脚本在 PyInstaller 解包后、运行主脚本之前执行（spec 的 runtime_hooks）。
# 目的：打包版是无控制台 GUI，任何早期崩溃都会静默死亡（无窗口、无日志），
# 本钩子把 stderr/stdout 落到文件 + faulthandler + excepthook，确保能抓到根因。

import os
import sys

# 1) 确保用户数据目录存在（打包模式下无控制台，日志目录必须显式创建）
# 打包版数据目录 = 程序运行目录（与 momoitor/config.py 保持一致）；
# 开发模式（理论上不会走到本钩子）退回 appdata。
if getattr(sys, "frozen", False):
    _DATA_DIR = os.path.dirname(sys.executable)
else:
    _appdata = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    _DATA_DIR = os.path.join(_appdata, "MoMoitor")
try:
    os.makedirs(_DATA_DIR, exist_ok=True)
except Exception:
    pass

_BOOT_LOG = os.path.join(_DATA_DIR, "boot.txt")

def _log_boot(msg):
    """记录引导阶段进展，随时可读。"""
    try:
        with open(_BOOT_LOG, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass

_log_boot("=== boot hook loaded ===")

# 2) 捕获原生崩溃（DLL 加载失败等致命错误）转储到文件
try:
    import faulthandler
    _crash = os.path.join(_DATA_DIR, "crash.txt")
    faulthandler.enable(file=open(_crash, "a", encoding="utf-8", buffering=1))
    _log_boot("faulthandler enabled -> " + _crash)
except Exception as e:
    _log_boot("faulthandler failed: " + repr(e))

# 3) 未处理 Python 异常：写入 crash.txt 并弹窗
def _excepthook(etype, value, tb):
    try:
        import traceback
        msg = "".join(traceback.format_exception(etype, value, tb))
        with open(os.path.join(_DATA_DIR, "crash.txt"), "a", encoding="utf-8") as f:
            f.write("\n===== UNHANDLED EXCEPTION =====\n" + msg)
        _log_boot("unhandled exception captured")
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg, "MoMoitor 崩溃了!", 0x10)
        except Exception:
            pass
    except Exception:
        pass
sys.excepthook = _excepthook
_log_boot("excepthook installed")

# 4) 把 stderr/stdout 重定向到文件：loguru 的 stderr sink 与任何 print/报错都落盘
try:
    _sink = open(os.path.join(_DATA_DIR, "stderr.txt"), "a", encoding="utf-8", buffering=1)
    sys.stderr = _sink
    sys.stdout = _sink
    _log_boot("stderr/stdout redirected")
except Exception as e:
    _log_boot("stderr redirect failed: " + repr(e))

_log_boot("boot hook done")
