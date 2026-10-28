import threading

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

    def notify_clipboard_received(self, content, content_type="text"):
        """Show a bounded preview without blocking clipboard synchronization."""
        if not self.config.data.get("clipboard_notifications", False):
            return
        try:
            if content_type == "text":
                title = f"{APP_NAME}: Text received 📝"
                message = content
            elif content_type == "image":
                title = f"{APP_NAME}: Image received 🖼️"
                message = f"Image copied to clipboard ({content.width} × {content.height} pixels)"
            elif content_type == "files":
                if not content:
                    return
                title = f"{APP_NAME}: Files received 📁"
                names = list(content)
                message = ", ".join(name[:200] for name in names[:3])
                if len(names) > 3:
                    message += f" (+{len(names) - 3} more)"
                message = f"{len(names)} file(s) available to download: {message}"
            else:
                return

            # Stay below the Windows balloon limit and keep previews readable.
            message = " ".join(message[:201].split())
            encoded_message = message.encode("utf-16-le")
            if len(encoded_message) > 400:
                message = encoded_message[:398].decode("utf-16-le", errors="ignore") + "…"
            threading.Thread(
                target=self.notify,
                kwargs={
                    "title": title,
                    "message": message or "Empty text copied to clipboard",
                    "preference": "clipboard_notifications",
                },
                daemon=True,
            ).start()
        except Exception:
            logging.exception("Failed to prepare clipboard notification")

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
