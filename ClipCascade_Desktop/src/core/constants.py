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


def _parse_linux_bool_flag_token(raw):
    if raw is None or not str(raw).strip():
        raise ValueError("empty value")
    s = str(raw).strip().lower()
    if s == "true":
        return True
    if s == "false":
        return False
    raise ValueError(raw)


def _parse_linux_positive_float(raw):
    if raw is None or not str(raw).strip():
        raise ValueError("empty value")
    try:
        value = float(str(raw).strip())
    except ValueError:
        raise ValueError(f"not a number: {raw!r}")
    if value <= 0:
        raise ValueError("must be a positive number")
    return value


def _strip_linux_cli_overrides(argv):
    """
    Linux-only: parse --gui / --xmode (true|false), --polling (seconds), remove them from argv.
    Last occurrence wins if a flag is repeated.
    """
    gui_override = None
    xmode_override = None
    polling_override = None
    i = 1
    kept = [argv[0]] if argv else []
    while i < len(argv):
        item = argv[i]
        if item.startswith("--gui="):
            gui_override = _parse_linux_bool_flag_token(item.split("=", 1)[1])
            i += 1
            continue
        if item == "--gui":
            if i + 1 >= len(argv):
                raise ValueError("--gui requires true or false")
            gui_override = _parse_linux_bool_flag_token(argv[i + 1])
            i += 2
            continue
        if item.startswith("--xmode="):
            xmode_override = _parse_linux_bool_flag_token(item.split("=", 1)[1])
            i += 1
            continue
        if item == "--xmode":
            if i + 1 >= len(argv):
                raise ValueError("--xmode requires true or false")
            xmode_override = _parse_linux_bool_flag_token(argv[i + 1])
            i += 2
            continue
        if item.startswith("--polling="):
            polling_override = _parse_linux_positive_float(item.split("=", 1)[1])
            i += 1
            continue
        if item == "--polling":
            if i + 1 >= len(argv):
                raise ValueError("--polling requires a positive number (seconds)")
            polling_override = _parse_linux_positive_float(argv[i + 1])
            i += 2
            continue
        kept.append(item)
        i += 1
    argv[:] = kept
    return gui_override, xmode_override, polling_override


PLATFORM = get_os_and_display_server()

# Linux: CLI UI vs GTK tray — False on other platforms (unused except behind LINUX checks).
LINUX_USE_CLI_UI = False
# Linux: optional override for xclip/wl-paste polling sleep (seconds); None = use built-ins (0.3 / 3).
LINUX_CLIPBOARD_POLL_INTERVAL_SEC = None

if PLATFORM.startswith(LINUX):
    if (
        detect_linux_display_server() == "X11"
        or detect_linux_display_server() == "XWayland"
        or detect_linux_display_server() == "Unknown"
    ):
        XMODE = True
    else:
        XMODE = False

    try:
        gui_override, xmode_override, polling_override = _strip_linux_cli_overrides(
            sys.argv
        )
    except ValueError as e:
        print(f"clipcascade (Linux CLI): {e}", file=sys.stderr)
        sys.exit(2)

    if xmode_override is not None:
        XMODE = xmode_override

    if gui_override is not None:
        LINUX_USE_CLI_UI = not gui_override
    else:
        LINUX_USE_CLI_UI = not XMODE

    if polling_override is not None:
        LINUX_CLIPBOARD_POLL_INTERVAL_SEC = polling_override


# App version
if PLATFORM == WINDOWS:
    APP_VERSION = "3.2.0"
elif PLATFORM == MACOS:
    APP_VERSION = "3.2.0"
elif PLATFORM.startswith(LINUX):
    if XMODE:
        APP_VERSION = "3.2.0"  # gui version
    else:
        APP_VERSION = "3.2.0"  # non-gui(cli) version


# core constants
RECONNECT_WS_TIMER = 10  # seconds
WEBSOCKET_TIMEOUT = 3000  # milliseconds

# P2P signaling WebSocket keepalive (RFC 6455 ping/pong).
P2P_WS_PING_INTERVAL_SEC = 25
P2P_WS_PING_TIMEOUT_SEC = 20
# After sleep, aiortc RTCPeerConnection.close() can block; cap wait so the asyncio
# thread does not stall (which would also block processing ASSIGNED_ID / PEER_LIST).
P2P_PC_CLOSE_TIMEOUT_SEC = 5.0

LOG_FILE_NAME = "clipcascade_log.log"
LOG_LEVEL = logging.INFO  # Use valid levels: DEBUG, INFO, WARNING, ERROR, CRITICAL
DATA_FILE_NAME = "DATA"
MAX_SIZE = 1048576  # 1 MiB
FRAGMENT_SIZE = 15360  # 15 KiB
SUBSCRIPTION_DESTINATION = "/user/queue/cliptext"
SEND_DESTINATION = "/app/cliptext"
LOGIN_URL = "/login"
LOGOUT_URL = "/logout"
MAXSIZE_URL = "/max-size"
CSRF_URL = "/csrf-token"
SERVER_MODE_URL = "/server-mode"
WEBSOCKET_ENDPOINT = "/clipsocket"
WEBSOCKET_ENDPOINT_P2P = "/p2psignaling"
STUN_URL = "/stun-url"

VERSION_URL = "https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/version.json"
RELEASE_URL = "https://github.com/Sathvik-Rao/ClipCascade/releases/latest"
GITHUB_URL = "https://github.com/Sathvik-Rao/ClipCascade"
APP_NAME = "ClipCascade"
HELP_URL = f"{GITHUB_URL}/blob/main/README.md"
METADATA_URL = "https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/metadata.json"

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
