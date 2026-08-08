"""系统音量调节 —— 基于 pycaw。

主要方法:
- adjust_volume(action, level): 调节系统音量

action: 'set' (0-100)、'get'、'up'、'down'、'mute'、'unmute'
"""

from loguru import logger

try:
    from pycaw.pycaw import AudioUtilities
    _HAS_PYCAW = True
except ImportError:
    _HAS_PYCAW = False


def adjust_volume(action: str, level: int = None) -> dict:
    """调节系统音量。action: 'set' (0-100)、'get'、'up'、'down'、'mute'、'unmute'。"""
    try:
        if not _HAS_PYCAW:
            return {"success": False, "error": "pycaw not installed"}
        devices = AudioUtilities.GetSpeakers()
        volume = devices.EndpointVolume

        if action == 'get':
            current = volume.GetMasterVolumeLevelScalar() * 100
            muted = volume.GetMute()
            return {"success": True, "level": round(current), "muted": bool(muted)}

        if action == 'set' and level is not None:
            level = max(0, min(100, level))
            volume.SetMasterVolumeLevelScalar(level / 100.0, None)
            return {"success": True, "level": level}

        if action == 'up':
            current = volume.GetMasterVolumeLevelScalar() * 100
            new_level = min(100, current + 5)
            volume.SetMasterVolumeLevelScalar(new_level / 100.0, None)
            return {"success": True, "level": round(new_level)}

        if action == 'down':
            current = volume.GetMasterVolumeLevelScalar() * 100
            new_level = max(0, current - 5)
            volume.SetMasterVolumeLevelScalar(new_level / 100.0, None)
            return {"success": True, "level": round(new_level)}

        if action == 'mute':
            volume.SetMute(True, None)
            return {"success": True, "muted": True}

        if action == 'unmute':
            volume.SetMute(False, None)
            return {"success": True, "muted": False}

        return {"success": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        logger.error("adjust_volume failed: {}", e)
        return {"success": False, "error": str(e)}