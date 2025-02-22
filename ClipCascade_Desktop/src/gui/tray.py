import math
import os
import threading
import time
import tkinter as tk
from tkinter import filedialog
import webbrowser
from pystray import Icon, MenuItem as item, Menu
from PIL import Image, ImageDraw

from core.config import Config
from gui.info import CustomDialog
from core.constants import *

if PLATFORM != WINDOWS:
    import subprocess


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
    ):
        self.on_connect_callback = on_connect_callback
        self.on_disconnect_callback = on_disconnect_callback
        self.on_logoff_callback = on_logoff_callback
        self.new_version_available = new_version_available
        self.github_url = github_url
        self.donation_url = donation_url
        self.ws_interface = ws_interface
        self.config = config

        self.is_disconnecting = False
        self.disconnecting_items = None
        self.is_file_download_enabled = False
        self.file_download_items = None
        self.previous_stats: str = ""
        self.previous_stats_items = None

        self.root = tk.Tk()
        self.root.withdraw()  # Hide the root window

        # Initial state: Connected
        self.is_connected = True

        # Create the tray icon
        self.icon = Icon(
            "ClipCascade", self.create_clipboard_icon(), menu=self.create_menu()
        )

        self.icon.title = "ClipCascade"

        self.update_stats()  # Start the stats update thread

    def run(self):
        self.icon.run()

    def create_clipboard_icon(self):
        width, height = 64, 64  # Icon dimensions
        image = Image.new("RGBA", (width, height), (255, 255, 255, 0))

        draw = ImageDraw.Draw(image)

        # Draw a clipboard shape
        clipboard_rect = [15, 10, 49, 50]
        draw.rectangle(clipboard_rect, fill=(200, 200, 200), outline=(0, 0, 0))

        # Draw the clipboard clip centered horizontally
        clip_width = 10
        clip_height = 5
        clip_x = (clipboard_rect[0] + clipboard_rect[2]) / 2 - clip_width / 2
        clip_rect = [clip_x, 5, clip_x + clip_width, 5 + clip_height]
        draw.rectangle(clip_rect, fill=(150, 150, 150), outline=(0, 0, 0))

        return image

    def create_clipboard_icon_with_dot(self):
        width, height = 64, 64  # Icon dimensions
        image = Image.new("RGBA", (width, height), (255, 255, 255, 0))

        draw = ImageDraw.Draw(image)

        # Draw a clipboard shape
        clipboard_rect = [15, 10, 49, 50]
        draw.rectangle(clipboard_rect, fill=(200, 200, 200), outline=(0, 0, 0))

        # Draw the clipboard clip centered horizontally
        clip_width = 10
        clip_height = 5
        clip_x = (clipboard_rect[0] + clipboard_rect[2]) / 2 - clip_width / 2
        clip_rect = [clip_x, 5, clip_x + clip_width, 5 + clip_height]
        draw.rectangle(clip_rect, fill=(150, 150, 150), outline=(0, 0, 0))

        # Draw a notification dot in the top-right corner with a shiny effect
        dot_radius = 8
        dot_center_x = width - dot_radius - 5
        dot_center_y = dot_radius + 5
        dot_bbox = [
            dot_center_x - dot_radius,
            dot_center_y - dot_radius,
            dot_center_x + dot_radius,
            dot_center_y + dot_radius,
        ]
        draw.ellipse(dot_bbox, fill=(0, 128, 255, 255))  # Blue dot

        # Add a shiny highlight to the dot
        highlight_radius = dot_radius // 2
        highlight_center_x = dot_center_x - highlight_radius // 2
        highlight_center_y = dot_center_y - highlight_radius // 2
        highlight_bbox = [
            highlight_center_x - highlight_radius,
            highlight_center_y - highlight_radius,
            highlight_center_x + highlight_radius,
            highlight_center_y + highlight_radius,
        ]
        draw.ellipse(
            highlight_bbox, fill=(255, 255, 255, 180)
        )  # Semi-transparent white highlight

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
        menu_items = [
            Menu.SEPARATOR,
            item("🗒️ Open Logs", self._open_logs),
            item("📂 Program Files", self._open_program_location),
            Menu.SEPARATOR,
            item("🏠 Homepage", self._open_homepage),
            item("❓ Help", self._open_help),
            item("💟 Donate", self._open_donate),
            item("🌐 GitHub", self._open_github),
            Menu.SEPARATOR,
            item("🔒 Logoff and Quit", self._on_logoff),
            item("❌ Quit", self._on_quit),
        ]

        # Add connect/disconnect option (top of the menu - 0 index)
        if not self.is_connected:
            menu_items.insert(0, item("🔗 Connect", self._on_connect, default=True))
        else:
            if self.is_disconnecting and self.disconnecting_items is not None:
                menu_items.insert(
                    self.disconnecting_items[1],
                    item(self.disconnecting_items[0], self.disconnecting_items[2]),
                )
            else:
                menu_items.insert(0, item("⛓️‍💥 Disconnect", self._on_disconnect))

        # Add update option (before the last 3 items)
        if self.new_version_available is not None and self.new_version_available[0]:
            menu_items.insert(
                len(menu_items) - 3,
                item(
                    f"🔄 Update ({self.new_version_available[2]} ➞ {self.new_version_available[1]})",
                    self._on_update,
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
                ),
            )

        # Add stats option (top of the menu - 0 index)
        if self.previous_stats_items is not None:
            menu_items.insert(
                self.previous_stats_items[1],
                item(
                    self.previous_stats_items[0],
                    self.previous_stats_items[2],
                    enabled=self.previous_stats_items[2] is not None,
                ),
            )

        return Menu(*menu_items)

    def update_menu(self, item_: tuple = None):
        self.icon.menu = self.create_menu(item_=item_)

    def update_stats(self):
        threading.Thread(target=self._update_stats_thread, daemon=True).start()

    def _update_stats_thread(self):
        while True:
            current_stats = self.ws_interface.get_stats()
            if current_stats is not None and self.previous_stats != current_stats:
                self.previous_stats = current_stats
                self.previous_stats_items = (current_stats, 0, None)
                self.update_menu()
            time.sleep(1)  # Sleep for 1 second

    @staticmethod
    def open_webbrowser(url):
        try:
            webbrowser.open(url)
        except Exception as e:
            CustomDialog(
                f"Failed to open the browser. Here is the URL: {url}\nError: {e}",
                msg_type="error",
            ).mainloop()

    def _on_update(self, icon, item):
        TaskbarPanel.open_webbrowser(self.new_version_available[3])

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
        TaskbarPanel.open_webbrowser(self.config.data["server_url"])

    def _open_github(self, icon, item):
        TaskbarPanel.open_webbrowser(self.github_url)

    def _open_help(self, icon, item):
        TaskbarPanel.open_webbrowser(HELP_URL)

    def _open_donate(self, icon, item):
        if self.donation_url is not None:
            TaskbarPanel.open_webbrowser(self.donation_url)

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
                CustomDialog(
                    f"Failed to open the log file '{log_file_path}'.\nError: {e}",
                    msg_type="error",
                ).mainloop()
        else:
            CustomDialog(
                f"Log file not found at '{log_file_path}'.", msg_type="error"
            ).mainloop()

    def _open_program_location(self, icon, item):
        try:
            program_location = get_program_files_directory()
            self.open_location(program_location)
        except Exception as e:
            CustomDialog(
                f"Failed to open the program location '{program_location}'.\nError: {e}",
                msg_type="error",
            ).mainloop()

    def enable_files_download(self, files):
        self.is_file_download_enabled = True
        self.icon.icon = self.create_clipboard_icon_with_dot()
        self.file_download_items = (
            "📥 Download File(s)",
            0,
            lambda icon, item: self._on_download(icon, item, files),
        )
        self.update_menu()

    def disable_files_download(self):
        self.is_file_download_enabled = False
        self.file_download_items = None
        self.icon.icon = self.create_clipboard_icon()
        self.update_menu()

    def _on_download(self, icon, item, files):
        """Download the files to the user's Downloads folder."""
        try:
            try:
                if self.config.data["default_file_download_location"] != "":
                    target_directory = self.config.data[
                        "default_file_download_location"
                    ]
                else:
                    target_directory = filedialog.askdirectory(
                        title="Select location to Save File(s)",
                        initialdir=get_downloads_folder(),
                    )
                if not target_directory:
                    logging.debug("No directory selected. Exiting.")
                    return
            except RuntimeError as re:
                target_directory = os.path.join(
                    get_program_files_directory(), "downloads"
                )
                if not os.path.exists(target_directory):
                    os.makedirs(target_directory)
                logging.error(
                    f"A runtime error occurred while starting filedialog to select a directory. Error: {re}.\n"
                    + f"Setting the default location to the program directory '{target_directory}'."
                )
                CustomDialog(
                    f"ClipCascade 📥: Saving files to the program directory '{target_directory}'.",
                    msg_type="info",
                    timeout=5000,
                ).mainloop()

            # Save each file to the chosen directory
            for filename, file_obj in files.items():
                file_path = os.path.join(target_directory, filename)
                with open(file_path, "wb") as f:
                    f.write(file_obj.getvalue())
                logging.debug(f"Saved: {file_path}")

        except Exception as e:
            msg = f"An error occurred while downloading files. Error: {e}"
            logging.error(msg)
            CustomDialog(
                msg,
                msg_type="error",
            ).mainloop()

    def _on_logoff(self, icon, item):
        try:
            if self.on_logoff_callback:
                self.on_logoff_callback()
            self.icon.stop()
            self.root.quit()
        except Exception as e:
            CustomDialog(
                f"An error occurred while logging off: {e}", msg_type="error"
            ).mainloop()

    def _on_quit(self, icon, item):
        self.icon.stop()
        self.root.quit()
