"""API mixin —— 数据备份与还原。

提供 export_backup / import_backup 两个前端方法：通过系统文件对话框选择
保存/打开 zip，底层由 services.backup 完成打包与还原。依赖 ApiCore 提供的
_window（文件对话框）与惰性服务（流量、天气、歌词）。
"""

import os

import webview
from loguru import logger

from momoitor.config import DATA_DIR, reload_settings
from momoitor.services import backup as backup_svc

_ZIP_TYPES = ("Zip Archive (*.zip)",)


class BackupMixin:
    """数据备份/还原能力。"""

    def export_backup(self):
        """导出备份：弹出保存对话框，将程序数据打包为 zip。

        返回:
            {"ok": True, "path": str} | {"ok": False, "cancelled": True} | {"ok": False, "error": str}
        """
        default_name = backup_svc.backup_filename()
        dest = None
        if self._window is not None:
            try:
                path = self._window.create_file_dialog(
                    webview.SAVE_DIALOG, save_filename=default_name, file_types=_ZIP_TYPES
                )
            except Exception as e:
                logger.warning("Save dialog failed, falling back to data dir: {}", e)
                path = None
            if not path:
                return {"ok": False, "cancelled": True}
            dest = path[0] if isinstance(path, (list, tuple)) else path
        else:
            # 服务端模式没有原生窗口：直接存到数据目录并返回路径
            dest = os.path.join(DATA_DIR, default_name)
        try:
            backup_svc.build_backup_zip(dest)
            return {"ok": True, "path": dest}
        except Exception as e:
            logger.error("Backup export failed: {}", e)
            return {"ok": False, "error": str(e)}

    def import_backup(self):
        """还原备份：弹出打开对话框选择 zip 并还原数据文件。

        还原期间暂停流量记录服务，完成后重载设置并刷新相关服务缓存。
        返回 {"ok": True, "restored": [...], "restart": True} 提示前端需重启生效。
        """
        if self._window is None:
            return {"ok": False, "error": "服务端模式不支持还原备份"}
        try:
            path = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=_ZIP_TYPES)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        if not path:
            return {"ok": False, "cancelled": True}
        zip_path = path[0] if isinstance(path, (list, tuple)) else path

        traffic_running = self._traffic is not None and self._traffic.running
        if self._traffic is not None:
            self._traffic.stop()
        try:
            restored = backup_svc.restore_backup(zip_path)
        except Exception as e:
            logger.error("Backup restore failed: {}", e)
            return {"ok": False, "error": str(e)}
        finally:
            if traffic_running:
                self.traffic.start()

        self._settings = reload_settings()
        if self._weather is not None:
            self._weather.invalidate()
        if self._lyrics is not None:
            self._lyrics.invalidate()
        return {"ok": True, "restored": restored, "restart": True}
