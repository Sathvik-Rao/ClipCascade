from core.constants import *
from core.config import Config

if PLATFORM == WINDOWS or (
    PLATFORM.startswith(LINUX) and not LINUX_USE_CLI_UI
):
    # WINDOWS: When creating the executable with pyinstaller, add --hidden-import plyer.platforms.win.notification
    from plyer import notification
elif PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
    from cli.info import CustomDialog
elif PLATFORM == MACOS:
    import subprocess


class NotificationManager:
    def __init__(self, config: Config):
        self.config = config

    def notify(self, title: str, message: str, app_name: str = APP_NAME, timeout=10,
               preference="notification"):
        if self.config.data.get(preference, True):
            try:
                if PLATFORM == WINDOWS or (
                    PLATFORM.startswith(LINUX) and not LINUX_USE_CLI_UI
                ):
                    notification.notify(
                        title=title,
                        message=message,
                        app_name=app_name,
                        timeout=timeout,  # seconds
                    )
                elif PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
                    CustomDialog(f"{title} : {message}").mainloop()
                elif PLATFORM == MACOS:
                    subprocess.run(
                        [
                            "osascript",
                            "-e",
                            "on run argv\n"
                            "display notification (item 2 of argv) with title (item 1 of argv)\n"
                            "end run",
                            title, message,
                        ],
                        timeout=10,
                    )
            except Exception as e:
                logging.error(f"Failed to handle notification: {e}")
