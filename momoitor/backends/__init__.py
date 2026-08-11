"""硬件监视后端。"""

from .base import BaseMonitor
from .lhm import LHMMonitor
from .hwinfo import HWiNFOMonitor
from .wmi import WMIMonitor
from .aida64 import AIDA64Monitor

__all__ = ["BaseMonitor", "LHMMonitor", "HWiNFOMonitor", "WMIMonitor", "AIDA64Monitor"]
