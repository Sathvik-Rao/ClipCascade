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
        stomp_manager=None,
        config: Config = None,
    ):
        self.on_connect_callback = on_connect_callback
        self.on_disconnect_callback = on_disconnect_callback
        self.on_logoff_callback = on_logoff_callback
        self.new_version_available = new_version_available
        self.github_url = github_url
        self.stomp_manager = stomp_manager
        self.config = config

        # Initial state: Connected
        self.is_connected = True

        self.menu_items = None
        self.numbered_menu = None
        self.loop_terminate = False

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
            ("🌐 GitHub", self._open_github),
            "",  # Menu Separator
            ("🔒 Logoff and Quit", self._on_logoff),
            ("❌ Quit", self._on_quit),
        ]

        # Add connect/disconnect option
        if not self.is_connected:
            menu_items.insert(0, ("🔗 Connect", self._on_connect))
        else:
            if item_ is not None and "disconnecting" in item_[0].lower():
                menu_items.insert(item_[1], (item_[0], item_[2]))
            else:
                menu_items.insert(0, ("⛓️‍💥 Disconnect", self._on_disconnect))

        # Add update option
        if self.new_version_available is not None and self.new_version_available[0]:
            menu_items.insert(
                len(menu_items) - 3,
                (
                    f"🔄 Update ({self.new_version_available[2]} ➞ {self.new_version_available[1]})",
                    self._on_update,
                ),
            )

        # Add files download option
        if item_ is not None and "file" in item_[0].lower():
            menu_items.insert(item_[1], (item_[0], item_[2]))

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
            if self.stomp_manager.is_auto_reconnecting:
                threading.Thread(target=self._wait_to_disconnect, daemon=True).start()
            else:
                self.is_connected = False
                self.update_menu(no_dialog=True)

    def _wait_to_disconnect(self):
        """
        Wait for the auto-reconnect timer to expire before disconnecting.
        """
        timeout = math.ceil(self.stomp_manager.get_total_timeout() / 1000)
        while timeout > 0:
            self.update_menu(
                item_=(
                    f"⏳ Disconnecting... ({timeout} sec)",
                    0,
                    None,
                ),  # text, location, callback
                no_dialog=True,
            )
            time.sleep(1)  # seconds
            timeout -= 1
        self.stomp_manager.is_auto_reconnecting = False
        self.is_connected = False
        self.update_menu()

    def _open_github(self):
        TaskbarPanel.open_webbrowser(self.github_url)

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
        self.update_menu(
            item_=(
                "📥 Download File(s)",
                0,
                lambda: self._on_download(files),
            )
        )

    def disable_files_download(self):
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
