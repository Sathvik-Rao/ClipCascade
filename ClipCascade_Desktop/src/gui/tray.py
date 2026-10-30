import math
import os
import threading
import time
import tkinter as tk
from tkinter import filedialog
import webbrowser
from pystray import Icon, MenuItem, Menu
from PIL import Image, ImageDraw

from utils.main_thread import on_main_thread
from utils.notification_manager import NotificationManager
from core.config import Config
from gui.info import CustomDialog
from gui.tk_owner import get_gui_root
from core.constants import *

if PLATFORM == MACOS:
    from PyObjCTools import AppHelper
    from gui.macos_tray import MacOSTrayIcon as TrayIcon
    from clipboard import clipboard_monitor_mac
elif PLATFORM == WINDOWS:
    from gui.windows_tray import WindowsTrayIcon as TrayIcon
elif PLATFORM.startswith(LINUX) and Icon.__module__ in ("pystray._gtk", "pystray._appindicator"):
    from gui.linux_tray import LinuxTrayIcon as TrayIcon
else:
    TrayIcon = Icon

if PLATFORM != WINDOWS:
    import subprocess

MACOS_SHUTDOWN_TIMEOUT = 15


def item(text, action, *, key=None, **kwargs):
    entry = MenuItem(text, action, **kwargs)
    # Dynamic labels need an identity independent of their displayed text.
    entry._clipcascade_key = key if key is not None else text
    return entry


class TaskbarPanel:
    def __init__(
        self,
        on_connect_callback: callable = None,
        on_disconnect_callback: callable = None,
        on_logoff_callback: callable = None,
        new_version_available: list = None,
        github_url: str = GITHUB_URL,
        donation_url: str = None,
        ws_interface=None,  # type= interfaces.ws_interface.WSInterface
        config: Config = None,
        on_shutdown_callback: callable = None,
    ):
        self.on_connect_callback = on_connect_callback
        self.on_disconnect_callback = on_disconnect_callback
        self.on_logoff_callback = on_logoff_callback
        self.new_version_available = new_version_available
        self.github_url = github_url
        self.donation_url = donation_url
        self.ws_interface = ws_interface
        self.config = config
        self.on_shutdown_callback = on_shutdown_callback
        self._shutdown_done = threading.Event()
        self._shutdown_watchdog = None

        self.is_disconnecting = False
        self.disconnecting_items = None
        self.is_file_download_enabled = False
        self._download_in_progress = False
        self._download_lock = threading.Lock()
        self._save_thread = None
        self.download_status = ""
        self.file_download_items = None
        self._stopped = threading.Event()
        self.previous_connection_status = None
        self.previous_stats: str = ""
        self.previous_stats_items = None

        self.root = (
            get_gui_root() if PLATFORM == MACOS or PLATFORM.startswith(LINUX)
            else tk.Tk()
        )
        self.root.withdraw()  # Hide the root window

        # Hide dock icon on macOS after creating tkinter window
        if PLATFORM == MACOS:
            try:
                from AppKit import NSApplication, NSApplicationActivationPolicyAccessory
                NSApplication.sharedApplication().setActivationPolicy_(NSApplicationActivationPolicyAccessory)
            except ImportError:
                pass

        # Initial state: Connected
        self.is_connected = True

        # Create the tray icon
        self.icon = TrayIcon(
            "ClipCascade", self.create_clipboard_icon(), menu=self.create_menu()
        )

        self.icon.title = "ClipCascade"

        self.update_stats()  # Start the stats update thread

    def run(self):
        if PLATFORM == WINDOWS:
            try:
                self.icon.run_with_shutdown(lambda: self._on_quit(None, None))
            finally:
                self._stopped.set()
                self.root.destroy()
            return
        if PLATFORM != MACOS:
            try:
                self.icon.run()
            finally:
                self._stopped.set()
            return

        # PyObjC callbacks re-entering Tk's macOS mainloop can corrupt its
        # saved Python thread state. Let AppKit own the tray's event loop.
        try:
            self.icon.run_with_shutdown(lambda: self._on_quit(None, None))
        finally:
            self._stopped.set()
            self.icon.stop()

    def _begin_macos_shutdown(self, logoff=False):
        with self._download_lock:
            if self._stopped.is_set():
                return
            self._stopped.set()
        logging.info("macOS shutdown requested (logoff=%s)", logoff)
        # Leave the watchdog armed after the UI closes, including while Python
        # waits for remaining threads. Normal process exit kills this daemon.
        self._shutdown_watchdog = threading.Timer(
            MACOS_SHUTDOWN_TIMEOUT, self._macos_shutdown_timeout,
        )
        self._shutdown_watchdog.daemon = True
        self._shutdown_watchdog.start()

        # Release native pasteboard objects on the main thread before workers
        # start closing connections. Their later stop() calls are idempotent.
        clipboard_monitor_mac.stop()

        def cleanup():
            try:
                self._wait_for_file_save()
                if self.on_shutdown_callback:
                    self.on_shutdown_callback(logoff)
            except Exception:
                logging.exception("macOS shutdown cleanup failed")
            finally:
                self._shutdown_done.set()

        threading.Thread(target=cleanup, name="MacOSShutdown", daemon=True).start()
        self._poll_macos_shutdown()

    def _macos_shutdown_timeout(self):
        # A large download may legitimately take longer than the network
        # cleanup timeout. Never force-exit in the middle of writing it.
        if self._save_thread is not None and self._save_thread.is_alive():
            self._shutdown_watchdog = threading.Timer(
                MACOS_SHUTDOWN_TIMEOUT, self._macos_shutdown_timeout,
            )
            self._shutdown_watchdog.daemon = True
            self._shutdown_watchdog.start()
        else:
            os._exit(1)

    def _poll_macos_shutdown(self):
        # Network cleanup may dispatch pasteboard work back to the main thread.
        # Keep servicing AppKit until it finishes; never join it here.
        if self._shutdown_done.is_set():
            logging.info("macOS shutdown cleanup finished")
            self.icon.stop()
        else:
            AppHelper.callLater(0.05, self._poll_macos_shutdown)

    def _create_clipboard_base_image(self):
        """Shared clipboard artwork for normal tray icon and file-download badge variant."""
        width, height = 64, 64
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)

        fill_color = (220, 220, 220)
        outline_color = (255, 255, 255)

        board_coords = (12, 12, 52, 57)
        try:
            draw.rounded_rectangle(
                board_coords, radius=5, fill=None, outline=outline_color, width=3
            )
        except (AttributeError, TypeError):
            draw.rectangle(board_coords, fill=None, outline=outline_color)

        clip_coords = (22, 7, 42, 17)
        try:
            draw.rounded_rectangle(
                clip_coords, radius=3, fill=fill_color, outline=outline_color, width=3
            )
        except (AttributeError, TypeError):
            draw.rectangle(clip_coords, fill=fill_color, outline=outline_color)

        return image

    def create_clipboard_icon(self):
        return self._create_clipboard_base_image()

    def create_clipboard_icon_with_dot(self):
        """Same clipboard as normal state, plus a blue notification dot for pending file download."""
        image = self._create_clipboard_base_image().copy()
        draw = ImageDraw.Draw(image)
        width, height = 64, 64

        dot_radius = 8
        dot_center_x = width - dot_radius - 5
        dot_center_y = dot_radius + 5
        dot_bbox = [
            dot_center_x - dot_radius,
            dot_center_y - dot_radius,
            dot_center_x + dot_radius,
            dot_center_y + dot_radius,
        ]
        draw.ellipse(dot_bbox, fill=(0, 128, 255, 255))

        highlight_radius = dot_radius // 2
        highlight_center_x = dot_center_x - highlight_radius // 2
        highlight_center_y = dot_center_y - highlight_radius // 2
        highlight_bbox = [
            highlight_center_x - highlight_radius,
            highlight_center_y - highlight_radius,
            highlight_center_x + highlight_radius,
            highlight_center_y + highlight_radius,
        ]
        draw.ellipse(highlight_bbox, fill=(255, 255, 255, 180))

        return image

    def create_menu(self, item_: tuple = None):
        """Create the menu for the tray icon.

        Args:
            item_ (tuple, optional): The item that triggered the menu. Defaults to None.
            item_ = (text, location, callback)
        Returns:
            Menu: The menu for the tray icon.
        """
        # Menu items
        version_suffix = (
            " (latest)"
            if self.new_version_available is not None
            and self.new_version_available[1] == APP_VERSION
            else ""
        )
        menu_items = [
            Menu.SEPARATOR,
            item("🗒️ Open logs", self._open_logs),
            item("📂 Program files", self._open_program_location),
            item("❓ Help / About", Menu(
                item("❓ Help", self._open_help),
                item("🏠 Homepage", self._open_homepage),
                item("🌐 GitHub", self._open_github),
                item("💟 Donate", self._open_donate),
                Menu.SEPARATOR,
                item(
                    f"ℹ️ Version {APP_VERSION}{version_suffix}", None,
                    enabled=False, key="version",
                ),
            )),
            Menu.SEPARATOR,
            item("🔒 Log out and quit", self._on_logoff),
            item("❌ Quit", self._on_quit),
        ]

        # Add connect/disconnect option (top of the menu - 0 index)
        if not self.is_connected:
            menu_items.insert(0, item("🔗 Start sync", self._on_connect, default=True))
        else:
            if self.is_disconnecting and self.disconnecting_items is not None:
                menu_items.insert(
                    self.disconnecting_items[1],
                    item(
                        self.disconnecting_items[0], self.disconnecting_items[2],
                        enabled=False, key="stop_sync",
                    ),
                )
            else:
                menu_items.insert(0, item("⛓️‍💥 Stop sync", self._on_disconnect, key="stop_sync"))

        # Add update option (before the last 3 items)
        if self.new_version_available is not None and self.new_version_available[0]:
            menu_items.insert(
                len(menu_items) - 3,
                item(
                    f"🔄 Update ({self.new_version_available[2]} ➞ {self.new_version_available[1]})",
                    self._on_update,
                    key="update",
                ),
            )

        # Add files download option (top of the menu - 0 index)
        if self.is_file_download_enabled and self.file_download_items is not None:
            menu_items.insert(
                self.file_download_items[1],
                item(
                    self.file_download_items[0],
                    self.file_download_items[2],
                    default=True,
                    enabled=not self._download_in_progress,
                    key="download",
                ),
            )

        if self.download_status:
            menu_items.insert(0, item(
                self.download_status, None, enabled=False, key="download_status",
            ))

        # Add stats option (top of the menu - 0 index)
        if self.previous_stats_items is not None:
            menu_items.insert(
                self.previous_stats_items[1],
                item(
                    self.previous_stats_items[0],
                    self.previous_stats_items[2],
                    enabled=self.previous_stats_items[2] is not None,
                    key="stats",
                ),
            )

        status, status_dot = self._connection_status()
        menu_items.insert(0, item(
            f"{status_dot} Clipboard sync: {status}", None,
            enabled=False, key="connection_status",
        ))
        return Menu(*menu_items)

    def _connection_status(self):
        if self.is_disconnecting:
            return "Stopping…", "🟠"
        if not self.is_connected:
            return "Stopped", "🔴"
        if self.ws_interface is not None and self.ws_interface.is_connected:
            return "Connected", "🟢"
        if self.ws_interface is not None and self.ws_interface.disconnected:
            return "Disconnected", "🔴"
        return "Reconnecting…", "🔴"

    @on_main_thread
    def update_menu(self, item_: tuple = None):
        if not self._stopped.is_set():
            self.icon.menu = self.create_menu(item_=item_)

    def update_stats(self):
        threading.Thread(target=self._update_stats_thread, daemon=True).start()

    def _update_stats_thread(self):
        while not self._stopped.is_set():
            checker = getattr(self, "update_checker", None)
            if checker:
                if checker.status is not None and checker.status != self.new_version_available:
                    self.new_version_available = checker.status
                    self.update_menu()
                status = checker.claim_alert(self.config.data.get("update_notifications", True))
                if status:
                    # The desktop client has no visible main window in tray mode.
                    NotificationManager(self.config).notify(
                        "ClipCascade update available",
                        f"Version {status[1]} is available. Open the tray menu to update.",
                        preference="update_notifications",
                    )
            current_stats = self.ws_interface.get_stats()
            connection_status = self._connection_status()
            stats_changed = current_stats is not None and self.previous_stats != current_stats
            if stats_changed:
                self.previous_stats = current_stats
                self.previous_stats_items = (current_stats, 0, None)
            if stats_changed or connection_status != self.previous_connection_status:
                self.previous_connection_status = connection_status
                self.update_menu()
            self._stopped.wait(1)

    def _show_tray_message(self, message, msg_type="error", timeout=None):
        if PLATFORM in (WINDOWS, MACOS) or PLATFORM.startswith(LINUX):
            NotificationManager(self.config).notify(
                f"ClipCascade: {'Error' if msg_type == 'error' else 'Information'}",
                message, preference=None,
            )
            return
        dialog = CustomDialog(message, msg_type=msg_type, timeout=timeout)
        # Wait only for this dialog, not for every Tk window (including the
        # hidden tray owner) to be destroyed.
        dialog.wait_window()

    def open_webbrowser(self, url):
        try:
            if not webbrowser.open(url):
                self._show_tray_message(f"Unable to open the browser. Here is the URL: {url}")
        except Exception as e:
            self._show_tray_message(
                f"Failed to open the browser. Here is the URL: {url}\nError: {e}",
            )

    def _on_update(self, icon, item):
        self.open_webbrowser(self.new_version_available[3])

    def _on_connect(self, icon, item):
        if self.on_connect_callback:
            try:
                self.on_connect_callback()
            except Exception as e:
                pass
            self.is_connected = True
            self.update_menu()

    def _on_disconnect(self, icon, item):
        if self.on_disconnect_callback:
            self.on_disconnect_callback()
            if self.ws_interface is not None and self.ws_interface.is_auto_reconnecting:
                threading.Thread(
                    target=self._wait_to_disconnect, args=(icon, item), daemon=True
                ).start()
            else:
                self.is_connected = False
                self.update_menu()

    def _wait_to_disconnect(self, icon, item):
        """
        Wait for the auto-reconnect timer to expire before disconnecting.
        """
        if self.ws_interface is None:
            return

        timeout = math.ceil(self.ws_interface.get_total_timeout() / 1000)
        while timeout > 0:
            self.is_disconnecting = True
            self.disconnecting_items = (
                f"⏳ Disconnecting... ({timeout} sec)",
                0,
                None,
            )  # text, location, callback
            self.update_menu()
            time.sleep(1)  # seconds
            timeout -= 1
        self.is_disconnecting = False
        self.disconnecting_items = None
        self.ws_interface.is_auto_reconnecting = False
        self.is_connected = False
        self.update_menu()

    def _open_homepage(self, icon, item):
        self.open_webbrowser(self.config.data["server_url"])

    def _open_github(self, icon, item):
        self.open_webbrowser(self.github_url)

    def _open_help(self, icon, item):
        self.open_webbrowser(HELP_URL)

    def _open_donate(self, icon, item):
        if self.donation_url is not None:
            self.open_webbrowser(self.donation_url)

    def open_location(self, path):
        if PLATFORM == WINDOWS:
            os.startfile(path)
        elif PLATFORM == MACOS:
            subprocess.run(["open", path])
        elif PLATFORM.startswith(LINUX):
            subprocess.run(["xdg-open", path])

    def _open_logs(self, icon, item):
        log_file_path = os.path.join(get_program_files_directory(), LOG_FILE_NAME)
        if os.path.exists(log_file_path):
            try:
                self.open_location(log_file_path)
            except Exception as e:
                self._show_tray_message(
                    f"Failed to open the log file '{log_file_path}'.\nError: {e}",
                )
        else:
            self._show_tray_message(f"Log file not found at '{log_file_path}'.")

    def _open_program_location(self, icon, item):
        try:
            program_location = get_program_files_directory()
            self.open_location(program_location)
        except Exception as e:
            self._show_tray_message(
                f"Failed to open the program location '{program_location}'.\nError: {e}",
            )

    @on_main_thread
    def enable_files_download(self, files):
        if self._stopped.is_set():
            return
        if not self._download_in_progress:
            self.download_status = ""
        self.is_file_download_enabled = True
        self.icon.icon = self.create_clipboard_icon_with_dot()
        self.file_download_items = (
            f"📥 Download {'File' if len(files) == 1 else 'Files'}",
            0,
            lambda icon, item: self._on_download(icon, item, files),
        )
        self.update_menu()

    @on_main_thread
    def disable_files_download(self):
        if self._stopped.is_set():
            return
        if not self._download_in_progress:
            self.download_status = ""
        self.is_file_download_enabled = False
        self.file_download_items = None
        self.icon.icon = self.create_clipboard_icon()
        self.update_menu()

    @on_main_thread
    def _set_download_status(self, message):
        if self._stopped.is_set():
            return
        self.download_status = message
        self.update_menu()

    def _choose_download_directory(self, files):
        if (PLATFORM == MACOS or PLATFORM.startswith(LINUX)) and threading.current_thread() is not threading.main_thread():
            # A GTK callback can be serviced by the clipboard's GTK loop.
            # Let the existing download fallback handle this without touching Tk.
            raise RuntimeError("Download picker must run on the main thread")
        if PLATFORM == MACOS:
            # AppKit owns the tray loop. A Tk picker would re-enter Tcl from
            # an AppKit callback, which can corrupt Tk's saved thread state.
            from AppKit import NSOpenPanel, NSModalResponseOK
            from Foundation import NSURL

            panel = NSOpenPanel.openPanel()
            panel.setTitle_(f"Select location to save {'file' if len(files) == 1 else 'files'}")
            panel.setCanChooseDirectories_(True)
            panel.setCanChooseFiles_(False)
            panel.setAllowsMultipleSelection_(False)
            panel.setCanCreateDirectories_(True)
            panel.setDirectoryURL_(NSURL.fileURLWithPath_(get_downloads_folder()))
            if panel.runModal() == NSModalResponseOK:
                return str(panel.URL().path())
            return ""
        options = {
            "parent": self.root,
            "title": f"Select location to save {'file' if len(files) == 1 else 'files'}",
            "initialdir": get_downloads_folder(),
        }
        if PLATFORM != WINDOWS:
            return filedialog.askdirectory(**options)

        # Windows downloads run on a dedicated thread. Create and destroy its
        # Tk owner on that same thread; never use the tray thread's Tk objects.
        from pythoncom import CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED

        CoInitializeEx(COINIT_APARTMENTTHREADED)
        picker_root = None
        try:
            picker_root = tk.Tk()
            picker_root.withdraw()
            picker_root.attributes("-topmost", True)
            options["parent"] = picker_root
            return filedialog.askdirectory(**options)
        finally:
            try:
                if picker_root is not None:
                    picker_root.destroy()
            finally:
                CoUninitialize()

    def _on_download(self, icon, item, files):
        if self._stopped.is_set() or self._download_in_progress:
            return
        self._download_in_progress = True
        if PLATFORM == WINDOWS:
            # A shell dialog must not run inside pystray's window procedure.
            # Keep the tray message loop free to process refreshes and clicks.
            try:
                threading.Thread(
                    target=self._start_download, args=(files,),
                    name="WindowsFileDownload", daemon=True,
                ).start()
            except Exception:
                self._download_in_progress = False
                raise
            return
        self._start_download(files)

    def _start_download(self, files):
        try:
            try:
                if self.config.data["default_file_download_location"] != "":
                    target_directory = self.config.data[
                        "default_file_download_location"
                    ]
                else:
                    target_directory = self._choose_download_directory(files)
                if not target_directory:
                    logging.debug("No directory selected. Exiting.")
                    self._download_in_progress = False
                    self.update_menu()
                    return
            except (RuntimeError, tk.TclError) as error:
                target_directory = os.path.join(
                    get_program_files_directory(), "downloads"
                )
                if not os.path.exists(target_directory):
                    os.makedirs(target_directory)
                logging.error(
                    f"Failed to open the download directory picker. Error: {error}.\n"
                    + f"Setting the default location to the program directory '{target_directory}'."
                )
                message = f"ClipCascade 📥: Saving files to the program directory '{target_directory}'."
                if PLATFORM == WINDOWS:
                    NotificationManager(self.config).notify(
                        "ClipCascade: Download location", message, preference=None,
                    )
                else:
                    self._show_tray_message(message, msg_type="info", timeout=5000)

            pending_files = list(files.items())
            total = len(pending_files)
            self._set_download_status(f"Saving 0 of {total} {'file' if total == 1 else 'files'}…")

            def save_files():
                saved = 0
                notifier = NotificationManager(self.config)
                failed = False
                try:
                    for filename, file_obj in pending_files:
                        file_path = os.path.join(target_directory, filename)
                        with open(file_path, "wb") as f:
                            f.write(file_obj.getvalue())
                        saved += 1
                        self._set_download_status(f"Saving {saved} of {total} {'file' if total == 1 else 'files'}…")
                    message = f"Downloaded {saved} {'file' if saved == 1 else 'files'} to: {target_directory}"
                    title = "ClipCascade: Download complete"
                except Exception as error:
                    failed = True
                    logging.exception("Failed to download files")
                    message = f"Download failed. Saved {saved} of {total} {'file' if total == 1 else 'files'}. {error}"
                    title = "ClipCascade: Download failed"
                finally:
                    self._download_in_progress = False
                self._set_download_status(message)
                notifier.notify(
                    title, message,
                    preference=None if failed else "download_notifications",
                )

            # Serialize starting a save against shutdown on every platform:
            # shutdown either waits for this save or prevents it from starting.
            with self._download_lock:
                if self._stopped.is_set():
                    self._download_in_progress = False
                    return
                self._save_thread = threading.Thread(
                    target=save_files, name="FileSave", daemon=False,
                )
                self._save_thread.start()
        except Exception as e:
            self._download_in_progress = False
            logging.exception("Failed to start file download")
            self._set_download_status(f"Download failed: {e}")
            if PLATFORM == WINDOWS:
                NotificationManager(self.config).notify(
                    "ClipCascade: Download failed", str(e), preference=None,
                )
            else:
                self._show_tray_message(f"Download failed: {e}")

    def _wait_for_file_save(self):
        save_thread = self._save_thread
        if save_thread is not None and save_thread.is_alive():
            logging.info("Waiting for file saving to finish before quitting")
            save_thread.join()

    def _begin_threaded_shutdown(self, logoff=False):
        with self._download_lock:
            if self._stopped.is_set():
                return
            self._stopped.set()

        def finish_shutdown():
            try:
                self._wait_for_file_save()
                if logoff and self.on_logoff_callback:
                    self.on_logoff_callback()
            except Exception as error:
                logging.exception("Tray shutdown cleanup failed")
                self._show_tray_message(f"Failed to finish logging off: {error}")
            finally:
                # Each backend schedules stop on its UI loop. On Windows, run()
                # then destroys Tk on the thread that created it.
                self.icon.stop()

        threading.Thread(
            target=finish_shutdown, name="TrayShutdown", daemon=False,
        ).start()

    def _on_logoff(self, icon, item):
        if PLATFORM == MACOS:
            self._begin_macos_shutdown(logoff=True)
            return
        self._begin_threaded_shutdown(logoff=True)

    def _on_quit(self, icon, item):
        if PLATFORM == MACOS:
            self._begin_macos_shutdown()
            return
        self._begin_threaded_shutdown()
