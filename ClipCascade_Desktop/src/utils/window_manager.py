import logging
import re
from core.constants import *


def center_window(win, max_height=None):
    """Center a Tk/Toplevel window on the primary monitor."""
    logging.debug(f"Centering window with max_height={max_height}")
    win.update_idletasks()
    window_width = win.winfo_width()
    window_height = win.winfo_height()
    if max_height:
        window_height = min(window_height, max_height)
    logging.debug(f"Window dimensions: {window_width}x{window_height}")
    primary_x, primary_y = 0, 0
    primary_w, primary_h = win.winfo_screenwidth(), win.winfo_screenheight()
    try:
        if PLATFORM.startswith(LINUX):
            logging.debug("Detecting monitors on Linux platform")
            import subprocess

            result = subprocess.run(
                ["xrandr", "--query"], capture_output=True, text=True, timeout=2
            )
            for line in result.stdout.splitlines():
                if " connected primary" in line:
                    m = re.search(r"(\d+)x(\d+)\+(\d+)\+(\d+)", line)
                    if m:
                        primary_w = int(m.group(1))
                        primary_h = int(m.group(2))
                        primary_x = int(m.group(3))
                        primary_y = int(m.group(4))
                        logging.debug(
                            f"Primary monitor: position=({primary_x}, {primary_y}), size={primary_w}x{primary_h}"
                        )
                    break
    except Exception as e:
        logging.warning(f"Failed to detect primary monitor: {e}. Using fallback dimensions.")
    x = primary_x + (primary_w - window_width) // 2
    y = primary_y + (primary_h - window_height) // 2
    x = max(primary_x, x)
    y = max(primary_y, y)
    logging.debug(f"Calculated window position: ({x}, {y})")
    win.geometry(f"{window_width}x{window_height}+{x}+{y}")
    logging.debug(f"Applied geometry: {window_width}x{window_height}+{x}+{y}")
