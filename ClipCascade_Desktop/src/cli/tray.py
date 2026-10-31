import math
import os
import sys
import threading
import time
import webbrowser
from contextlib import nullcontext
from itertools import count

from prompt_toolkit import PromptSession
from prompt_toolkit.patch_stdout import patch_stdout
from prompt_toolkit.utils import get_cwidth

from cli.echo import Echo
from cli.info import CustomDialog
from core.config import Config
from core.constants import *
from clipboard.file_utils import save_download_file


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
        self._menu_lock = threading.RLock()
        self._prompt_session = None
        self._displayed_menu = ""
        self._displayed_numbered_menu = {}

        self.update_stats()  # Start the stats update thread

    def run(self):
        Echo("-" * 53)
        self.update_menu(no_dialog=True)
        if sys.stdin.isatty() and sys.stdout.isatty():
            # Reuse the prompt's terminal space after Enter instead of leaving
            # a completed copy of the whole menu in scrollback.
            self._prompt_session = PromptSession(
                refresh_interval=0.5, erase_when_done=True
            )
        # Redirect background notifications above the live prompt instead of
        # letting them overwrite the menu or the user's partially typed choice.
        with patch_stdout() if self._prompt_session is not None else nullcontext():
            try:
                self._run_menu()
            except (EOFError, KeyboardInterrupt):
                self._on_quit()
            finally:
                self._prompt_session = None

    def _run_menu(self):
        while not self.loop_terminate:
            if self._prompt_session is not None:
                choice = self._prompt_session.prompt(self._get_menu_prompt)
            else:
                # Keep redirected input usable without terminal control codes.
                choice = input(self._get_menu_prompt())
            if choice == "":
                continue

            if choice.isdigit():
                choice = int(choice)
            else:
                Echo("Invalid choice. Please enter a number.")
                continue

            if choice in self._displayed_numbered_menu:
                fun = self._displayed_numbered_menu[choice][1]
                if fun is not None:
                    fun()
            else:
                Echo("Invalid choice.")

    def _get_menu_prompt(self):
        with self._menu_lock:
            # New download/update rows can change option numbers. Keep the
            # displayed choices stable while the user is entering a selection.
            typing = (
                self._prompt_session is not None
                and self._prompt_session.default_buffer.text
            )
            if not typing or not self._displayed_menu:
                self._displayed_menu = self._format_menu() + "\nChoice: "
                self._displayed_numbered_menu = self.numbered_menu.copy()
            return self._displayed_menu

    def get_max_width(self):
        """Measure terminal columns using the same widths as the prompt renderer."""
        return max(get_cwidth(row) for row in self._menu_rows())

    def _menu_rows(self):
        counter = count(1)
        return [
            (f"{next(counter):<2}. {item[0]}" if callable(item[1]) else f"    {item[0]}")
            if isinstance(item, tuple) else ""
            for item in self.menu_items
        ]

    def display_menu(self):
        Echo(self._format_menu())

    def _format_menu(self):
        inner_width = max(self.get_max_width(), get_cwidth(" MAIN MENU ")) + 2
        lines = []

        # Box Top Border
        lines.append("\n╔" + "═" * inner_width + "╗")
        lines.append(f"║{' MAIN MENU ':^{inner_width}}║")
        lines.append("╠" + "═" * inner_width + "╣")

        # Menu Items
        for row in self._menu_rows():
            if row:
                padding = " " * (inner_width - get_cwidth(row) - 2)
                lines.append(f"║ {row}{padding} ║")
            else:
                lines.append(f"║ {'─' * (inner_width - 2)} ║")

        # Box Bottom Border
        lines.append("╚" + "═" * inner_width + "╝")
        return "\n".join(lines)

    def create_menu(self, item_: tuple = None):
        # Menu items
        version_suffix = (
            " (latest)"
            if self.new_version_available is not None
            and self.new_version_available[1] == APP_VERSION
            else ""
        )
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
            (f"ℹ️  Version v{APP_VERSION}{version_suffix}", None),  # Read-only version display
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
            next(counter): item for item in menu_items
            if isinstance(item, tuple) and callable(item[1])
        }

        return (menu_items, numbered_menu)

    def update_menu(self, item_: tuple = None, no_dialog=False):
        # Keep the shared tray method signature; CLI refreshes are always silent.
        with self._menu_lock:
            self.menu_items, self.numbered_menu = self.create_menu(item_=item_)

    def update_stats(self):
        threading.Thread(target=self._update_stats_thread, daemon=True).start()

    def _update_stats_thread(self):
        while not self.loop_terminate:
            checker = getattr(self, "update_checker", None)
            if checker:
                if checker.status is not None and checker.status != self.new_version_available:
                    self.new_version_available = checker.status
                    self.update_menu(no_dialog=True)
                status = checker.claim_alert(self.config.data.get("update_notifications", True))
                if status:
                    CustomDialog(
                        f"ClipCascade {status[1]} is available.",
                        msg_type="info",
                    ).mainloop()
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
            f"📥 Download {'File' if len(files) == 1 else 'Files'}",
            0,
            lambda: self._on_download(files),
        )
        self.update_menu()

    def disable_files_download(self):
        if not self.is_file_download_enabled and self.file_download_items is None:
            return
        self.is_file_download_enabled = False
        self.file_download_items = None
        self.update_menu()

    def _on_download(self, files):
        saved = 0
        try:
            if self.config.data["default_file_download_location"] != "":
                target_directory = self.config.data["default_file_download_location"]
            else:
                target_directory = input(f"Enter the location to save {'file' if len(files) == 1 else 'files'}: ").strip()
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
                file_path = save_download_file(
                    target_directory, filename, file_obj.getvalue(), files.keys()
                )
                saved += 1
                logging.debug(f"Saved: {file_path}")
                CustomDialog(f"Saved {saved} of {len(files)} {'file' if len(files) == 1 else 'files'}: {os.path.basename(file_path)}", msg_type="info").mainloop()
            CustomDialog(f"Downloaded {len(files)} {'file' if len(files) == 1 else 'files'} to: {target_directory}", msg_type="success").mainloop()

        except Exception as e:
            msg = f"Download failed. Saved {saved} of {len(files)} {'file' if len(files) == 1 else 'files'}. {e}"
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
