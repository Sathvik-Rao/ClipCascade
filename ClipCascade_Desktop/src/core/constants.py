import logging
import platform
import os
import sys

# platform constants
WINDOWS = "Windows"
MACOS = "macOS"
LINUX = "Linux"
LINUX_X11 = f"{LINUX}_X11"
LINUX_WAYLAND = f"{LINUX}_Wayland"
LINUX_HEADLESS = f"{LINUX}_Headless"


# OS detection
def get_os_and_display_server():
    system = platform.system().lower().strip()
    if system == "windows":
        return WINDOWS
    elif system == "darwin":
        return MACOS
    elif system == "linux":
        session_type = os.environ.get("XDG_SESSION_TYPE", "").lower().strip()
        if session_type == "wayland":
            return LINUX_WAYLAND
        elif session_type == "x11":
            return LINUX_X11
        else:
            # Could be a headless session or another type of session
            return LINUX_HEADLESS
    else:
        return "Unknown OS"


def detect_linux_display_server():
    session_type = os.environ.get("XDG_SESSION_TYPE", "").lower().strip()
    session_desktop = os.environ.get("XDG_SESSION_DESKTOP", "").lower().strip()
    wayland_display = os.environ.get("WAYLAND_DISPLAY")
    x_display = os.environ.get("DISPLAY")

    # Priority detection order: X11 > XWayland > Hyprland > Wayland > Unknown

    if session_type == "x11":
        return "X11"

    if session_type == "wayland" and x_display and wayland_display:
        return "XWayland"

    if session_type == "wayland" and session_desktop == "hyprland":
        return "Hyprland"

    if session_type == "wayland":
        return "Wayland"

    return "Unknown"


PLATFORM = get_os_and_display_server()

if PLATFORM.startswith(LINUX):
    if (
        detect_linux_display_server() == "X11"
        or detect_linux_display_server() == "XWayland"
        or detect_linux_display_server() == "Unknown"
    ):
        XMODE = True
    else:
        XMODE = False


# App version
if PLATFORM == WINDOWS:
    APP_VERSION = "1.3.0"
elif PLATFORM == MACOS:
    APP_VERSION = "1.3.1"
elif PLATFORM.startswith(LINUX):
    if XMODE:
        APP_VERSION = "1.3.2"  # gui version
    else:
        APP_VERSION = "1.3.2"  # non-gui(cli) version


# core constants
RECONNECT_STOMP_TIMER = 10  # seconds
WEBSOCKET_TIMEOUT = 3000  # milliseconds
LOG_FILE_NAME = "clipcascade_log.log"
LOG_LEVEL = logging.INFO  # Use valid levels: DEBUG, INFO, WARNING, ERROR, CRITICAL
DATA_FILE_NAME = "DATA"
MAX_SIZE = 1048576  # 1 MiB
VERSION_URL = (
    "https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/version.json"
)
RELEASE_URL = "https://github.com/Sathvik-Rao/ClipCascade/releases/latest"
GITHUB_URL = "https://github.com/Sathvik-Rao/ClipCascade"
APP_NAME = "ClipCascade"

if PLATFORM == WINDOWS:
    MUTEX_NAME = "Global\\ClipCascade_Mutex_PSSR"
elif PLATFORM == MACOS or PLATFORM.startswith(LINUX):
    MUTEX_NAME = "clipcascade.lock"


# helper functions
def get_user_home_directory():
    """
    Get the user's home directory in a cross-platform manner.
    On Windows, this resolves to something like C:\\Users\\<Username>
    On macOS and Linux, this typically resolves to /Users/<Username> or /home/<Username>, respectively.
    """
    return os.path.expanduser("~")


def get_program_files_directory():
    """
    Get the directory containing the program files.
    """
    if PLATFORM == MACOS:
        app_dir = os.path.join(
            get_user_home_directory(), "Library", "Application Support", "ClipCascade"
        )
        if not os.path.exists(app_dir):
            try:
                os.makedirs(app_dir)
            except Exception as e:
                raise e

        return app_dir
    else:
        if getattr(sys, "frozen", False):  # Running as a PyInstaller executable
            return os.path.dirname(sys.executable)
        else:  # Running as a regular Python script
            running_dir = os.path.dirname(os.path.abspath(__file__))
            parent_dir = os.path.dirname(running_dir)  # Go one folder up
            return parent_dir


def get_downloads_folder():
    """
    Get the path to the user's Downloads folder in a cross-platform manner.
    By default, the Downloads directory is commonly located as:
    - Windows: C:\\Users\\<Username>\\Downloads
    - macOS: /Users/<Username>/Downloads
    - Linux: /home/<Username>/Downloads
    """
    return os.path.join(get_user_home_directory(), "Downloads")
