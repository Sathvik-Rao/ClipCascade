import re
from core.constants import *

def center_window(win, max_height=None):
    """Center a Tk/Toplevel window on the primary monitor."""
    win.update_idletasks()

    window_width = win.winfo_width()
    window_height = win.winfo_height()
    if max_height:
        window_height = min(window_height, max_height)

    primary_x, primary_y = 0, 0
    primary_w, primary_h = win.winfo_screenwidth(), win.winfo_screenheight()

    try:
        if PLATFORM == WINDOWS:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.windll.user32
            try:
                user32.SetProcessDPIAware()
            except Exception:
                pass

            monitors = []

            MONITORENUMPROC = ctypes.WINFUNCTYPE(
                wintypes.BOOL,
                wintypes.HMONITOR,
                wintypes.HDC,
                ctypes.POINTER(wintypes.RECT),
                wintypes.LPARAM,
            )

            def _monitor_cb(hMonitor, hdcMonitor, lprcMonitor, dwData):
                rc = lprcMonitor.contents
                monitors.append((rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top))
                return True

            user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(_monitor_cb), 0)

            for mx, my, mw, mh in monitors:
                if mx == 0 and my == 0:
                    primary_x, primary_y, primary_w, primary_h = mx, my, mw, mh
                    break

        elif PLATFORM == MACOS:
            from AppKit import NSScreen
            screen = NSScreen.mainScreen()
            frame = screen.frame()
            primary_x = int(frame.origin.x)
            primary_y = int(frame.origin.y)
            primary_w = int(frame.size.width)
            primary_h = int(frame.size.height)

        elif PLATFORM.startswith(LINUX):
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
                    break
    except Exception:
        pass

    x = primary_x + (primary_w - window_width) // 2
    y = primary_y + (primary_h - window_height) // 2

    x = max(primary_x, x)
    y = max(primary_y, y)

    win.geometry(f"{window_width}x{window_height}+{x}+{y}")
