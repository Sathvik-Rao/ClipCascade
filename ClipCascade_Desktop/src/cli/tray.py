import math
import os
import threading
import time
import webbrowser


from cli.echo import Echo
from cli.info import CustomDialog
from core.config import Config
from core.constants import *
from itertools import count


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

        # Initial state: Connected
        self.is_connected = True

        self.menu_items = None
        self.numbered_menu = None
        self.loop_terminate = False

        self.update_stats()  # Start the stats update thread

    def run(self):
        Echo("-" * 53)
        self.menu_items, self.numbered_menu = self.create_menu()

        while not self.loop_terminate:
            Echo("\n")

            self.display_menu()

            # input
            choice = input("Choice: \n")
            Echo("Please wait...")
            if choice == "":  # refresh
                continue

            if choice.isdigit():
                choice = int(choice)
            else:
                Echo("Invalid choice. Please enter a number.")

            if choice in self.numbered_menu:
                fun = self.numbered_menu[choice][1]
                if fun is not None:
                    fun()
            else:
                Echo("Invalid choice.")

    def get_max_width(self):
        """Determine the maximum width of menu item texts."""
        menu_texts = [
            item[0] if isinstance(item, tuple) else "" for item in self.menu_items
        ]
        return max(len(text) for text in menu_texts) + 1

    def display_menu(self):
        counter = count(1)
        max_width = self.get_max_width()

        total_width = max_width + 8

        # Box Top Border
        print("\n╔" + "═" * (max_width + 6) + "╗")
        print(f"║{' MAIN MENU ':^{max_width + 6}}║")
        print("╠" + "═" * (max_width + 6) + "╣")

        # Menu Items
        for item in self.menu_items:
            if isinstance(item, tuple):
                width = max_width
                if "disconnect" in item[0].lower() or "logs" in item[0].lower():
                    if "disconnecting" in item[0].lower():
                        width -= 1
                    else:
                        width += 1
                else:
                    width -= 1
                print(f"║ {next(counter):<2}. {item[0]:<{width}} ║")
            else:
                print(f"║ {'─' * (max_width + 4)} ║")

        # Box Bottom Border
        print("╚" + "═" * (max_width + 6) + "╝")

    def create_menu(self, item_: tuple = None):
        # Menu items
        menu_items = [
            "",  # Menu Separator
            ("🗒️  Open Logs", self._open_logs),
            ("📂 Program Files", self._open_program_location),
            "",  # Menu Separator
            ("🏠 Homepage", self._open_homepage),
            ("❓ Help", self._open_help),
            ("💟 Donate", self._open_donate),
            ("🌐 GitHub", self._open_github),
            "",  # Menu Separator
            ("🔒 Logoff and Quit", self._on_logoff),
            ("❌ Quit", self._on_quit),
        ]

        # Add connect/disconnect option (top of the menu - 0 index)
        if not self.is_connected:
            menu_items.insert(0, ("🔗 Connect", self._on_connect))
        else:
            if self.is_disconnecting and self.disconnecting_items is not None:
                menu_items.insert(
                    self.disconnecting_items[1],
                    (self.disconnecting_items[0], self.disconnecting_items[2]),
                )
            else:
                menu_items.insert(0, ("⛓️‍💥 Disconnect", self._on_disconnect))

        # Add update option (before the last 3 items)
        if self.new_version_available is not None and self.new_version_available[0]:
            menu_items.insert(
                len(menu_items) - 3,
                (
                    f"🔄 Update ({self.new_version_available[2]} ➞ {self.new_version_available[1]})",
                    self._on_update,
                ),
            )

        # Add files download option (top of the menu - 0 index)
        if self.is_file_download_enabled and self.file_download_items is not None:
            menu_items.insert(
                self.file_download_items[1],
                (self.file_download_items[0], self.file_download_items[2]),
            )

        # Add stats option (top of the menu - 0 index)
        if self.previous_stats_items is not None:
            menu_items.insert(
                self.previous_stats_items[1],
                (self.previous_stats_items[0], self.previous_stats_items[2]),
            )

        # Create numbered menu
        counter = count(1)
        numbered_menu = {
            next(counter): item for item in menu_items if isinstance(item, tuple)
        }

        return (menu_items, numbered_menu)

    def update_menu(self, item_: tuple = None, no_dialog=False):
        self.menu_items, self.numbered_menu = self.create_menu(item_=item_)
        if not no_dialog:
            CustomDialog(
                "Menu Updated! Press Enter to Refresh. ⏎", msg_type="info"
            ).mainloop()

    def update_stats(self):
        threading.Thread(target=self._update_stats_thread, daemon=True).start()

    def _update_stats_thread(self):
        while True:
            current_stats = self.ws_interface.get_stats()
            if current_stats is not None and self.previous_stats != current_stats:
                self.previous_stats = current_stats
                self.previous_stats_items = (current_stats, 0, None)
                self.update_menu(no_dialog=True)
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

    def _on_update(self):
        TaskbarPanel.open_webbrowser(self.new_version_available[3])

    def _on_connect(self):
        if self.on_connect_callback:
            try:
                self.on_connect_callback()
            except Exception as e:
                pass
            self.is_connected = True
            self.update_menu(no_dialog=True)

    def _on_disconnect(self):
        if self.on_disconnect_callback:
            self.on_disconnect_callback()
            if self.ws_interface is not None and self.ws_interface.is_auto_reconnecting:
                threading.Thread(target=self._wait_to_disconnect, daemon=True).start()
            else:
                self.is_connected = False
                self.update_menu(no_dialog=True)

    def _wait_to_disconnect(self):
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
            self.update_menu(no_dialog=True)
            time.sleep(1)  # seconds
            timeout -= 1
        self.is_disconnecting = False
        self.disconnecting_items = None
        self.ws_interface.is_auto_reconnecting = False
        self.is_connected = False
        self.update_menu()

    def _open_homepage(self):
        TaskbarPanel.open_webbrowser(self.config.data["server_url"])

    def _open_github(self):
        TaskbarPanel.open_webbrowser(self.github_url)

    def _open_help(self):
        TaskbarPanel.open_webbrowser(HELP_URL)

    def _open_donate(self):
        if self.donation_url is not None:
            TaskbarPanel.open_webbrowser(self.donation_url)

    def open_location(self, path):
        if PLATFORM == WINDOWS:
            os.startfile(path)
        elif PLATFORM == MACOS:
            subprocess.run(["open", path])
        elif PLATFORM.startswith(LINUX):
            subprocess.run(["xdg-open", path])

    def _open_logs(self):
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

    def _open_program_location(self):
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
        self.file_download_items = (
            "📥 Download File(s)",
            0,
            lambda: self._on_download(files),
        )
        self.update_menu()

    def disable_files_download(self):
        self.is_file_download_enabled = False
        self.file_download_items = None
        self.update_menu()

    def _on_download(self, files):
        try:
            if self.config.data["default_file_download_location"] != "":
                target_directory = self.config.data["default_file_download_location"]
            else:
                target_directory = input("Enter the location to save file(s): ").strip()
            if not target_directory:
                CustomDialog(
                    "No input provided. Please enter a valid directory path.",
                    msg_type="error",
                ).mainloop()
                return

            if not os.path.isdir(target_directory):
                CustomDialog("Invalid directory path.", msg_type="error").mainloop()
                return

            if not os.access(target_directory, os.W_OK):
                CustomDialog(
                    "Insufficient permissions to write to the directory.",
                    msg_type="error",
                ).mainloop()
                return

            CustomDialog(
                f"Saving files to: {target_directory}", msg_type="info"
            ).mainloop()
            # Save each file to the chosen directory
            for filename, file_obj in files.items():
                file_path = os.path.join(target_directory, filename)
                with open(file_path, "wb") as f:
                    f.write(file_obj.getvalue())
                logging.debug(f"Saved: {file_path}")
            CustomDialog("Done.", msg_type="success").mainloop()

        except Exception as e:
            msg = f"An error occurred while downloading files. Error: {e}"
            logging.error(msg)
            CustomDialog(
                msg,
                msg_type="error",
            ).mainloop()

    def _on_logoff(self):
        try:
            if self.on_logoff_callback:
                self.on_logoff_callback()
            self._on_quit()
        except Exception as e:
            CustomDialog(
                f"An error occurred while logging off: {e}", msg_type="error"
            ).mainloop()

    def _on_quit(self):
        self.loop_terminate = True
