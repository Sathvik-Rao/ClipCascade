import atexit
import errno
import logging
import signal
import sys


from core.constants import *

from core.config import Config
from utils.request_manager import RequestManager
from utils.transport_manager import TransportManager
from utils.cipher_manager import CipherManager
from utils.update_checker import UpdateChecker, parse_version
from stomp_ws.stomp_manager import STOMPManager
from p2p.p2p_manager import P2PManager

if PLATFORM == WINDOWS:
    import ctypes
elif PLATFORM == MACOS or PLATFORM.startswith(LINUX):
    import fcntl


if PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
    import pyfiglet
    from cli.login import LoginForm
    from cli.info import CustomDialog
    from cli.tray import TaskbarPanel
    from cli.echo import Echo
else:
    from gui.login import LoginForm
    from gui.info import CustomDialog
    from gui.tray import TaskbarPanel


class Application:
    def __init__(
        self,
        log_file_path=LOG_FILE_NAME,
        data_file_path=DATA_FILE_NAME,
        mutex_identifier=MUTEX_NAME,
    ):
        self._macos_shutdown_complete = False
        self.update_checker = UpdateChecker(self.get_version_update_status)
        try:
            self.log_file_path = os.path.join(
                get_program_files_directory(), log_file_path
            )
            self.data_file_path = os.path.join(
                get_program_files_directory(), data_file_path
            )
            self.mutex_identifier = mutex_identifier

            if PLATFORM == MACOS or PLATFORM.startswith(LINUX):
                self.lock_file = None  # File(lock) object
                self.mutex_identifier = os.path.join(
                    get_program_files_directory(), self.mutex_identifier
                )

            self.config = Config(
                file_name=self.data_file_path
            )  # Maintain a single configuration instance for the entire application lifecycle.

            self.request_manager = RequestManager(self.config)
            self.stomp_manager = STOMPManager(self.config)
            self.p2p_manager = P2PManager(self.config)
            self.transport_manager = TransportManager(
                self.config, self.request_manager, self.stomp_manager, self.p2p_manager
            )
            self.cipher_manager = CipherManager(self.config)
        except Exception as e:
            CustomDialog(
                f"An error occurred during application initialization: {e}",
                msg_type="error",
            ).mainloop()

    def setup_logging(self):
        LOG_FORMAT = "%(asctime)s - %(levelname)s - %(message)s"
        logging.basicConfig(
            level=LOG_LEVEL,
            format=LOG_FORMAT,
            filename=self.log_file_path,
            filemode="w",
        )

    def ensure_single_instance(self):
        if PLATFORM == WINDOWS:
            ctypes.windll.kernel32.CreateMutexW(None, False, self.mutex_identifier)
            if ctypes.windll.kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
                CustomDialog(
                    "Another instance of ClipCascade is already running.",
                    msg_type="warning",
                ).mainloop()
                sys.exit(0)
        elif PLATFORM == MACOS or PLATFORM.startswith(LINUX):
            if PLATFORM == MACOS:
                app_dir = get_program_files_directory()
                if not os.path.exists(app_dir):
                    try:
                        os.makedirs(app_dir)
                    except Exception as e:
                        CustomDialog(
                            f"An error occurred while creating the directory '{app_dir}'. Error: {e}",
                            msg_type="error",
                        ).mainloop()
                        sys.exit(1)

            # The kernel lock determines ownership, not the file's existence or PID.
            # Keep the same file in place so all launches lock the same inode.
            try:
                self.create_lock_file()
            except OSError as error:
                if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                    raise
                CustomDialog(
                    "Another instance of ClipCascade is already running.",
                    msg_type="warning",
                ).mainloop()
                sys.exit(0)

            # Backup cleanup paths for crashes / signals — finally in run() only
            # runs on normal completion or handled exceptions.
            atexit.register(self._cleanup_lock_file)
            self._install_signal_handlers()

    def create_lock_file(self, path=None):
        if path is None:
            path = self.mutex_identifier

        if PLATFORM == MACOS or PLATFORM.startswith(LINUX):
            lock_file = open(path, "a+")
            try:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                lock_file.seek(0)
                lock_file.truncate()
                lock_file.write(str(os.getpid()))
                lock_file.flush()
            except BaseException:
                lock_file.close()
                raise
            self.lock_file = lock_file

    def _install_signal_handlers(self):
        def _handler(signum, _frame):
            self._cleanup_lock_file()
            # Re-raise default behavior so the process actually exits.
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)

        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP) if hasattr(signal, "SIGHUP") else (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, _handler)
            except (ValueError, OSError):
                # Some platforms / non-main-thread inits disallow this; skip silently.
                pass

    def _cleanup_lock_file(self):
        if PLATFORM != MACOS and not PLATFORM.startswith(LINUX):
            return
        if self.lock_file is None:
            return
        # Closing releases the kernel lock, including after a crash. Never unlink
        # the file: another process may already have it open or acquire it next.
        try:
            self.lock_file.close()
        except Exception:
            pass
        self.lock_file = None

    def authenticate_and_connect(self):
        # Attempt to connect with existing cookie
        if self.config.data.get("cookie"):
            ws_conn_successful, msg = self._get_ws_manager().connect()
            if ws_conn_successful:
                self._get_ws_manager().is_login_phase = False
                return

        # enable login form
        used_saved_credentials = False
        display_login_success_dialog = False
        if PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
            Echo("═" * 14 + "\n║ LOGIN FORM ║\n" + "═" * 14)
        while True:
            if (
                self.config.data.get("cookie") is not None
                and self.config.data["save_password"]
                and self.config.data["cipher_enabled"] == False
                and not used_saved_credentials
            ):
                # Attempt to connect with password when using saved credentials
                used_saved_credentials = True
            else:
                display_login_success_dialog = True
                self.config.data["password"] = ""  # Clear the password
                login_form = LoginForm(
                    self.config,
                    on_quit_callback=(
                        None
                        if (PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI)
                        else lambda: sys.exit(0)
                    ),
                )
                if not (PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI):
                    login_form.watch_updates(self.update_checker)
                login_form.mainloop()  # wait until login form is closed
                raw_password = self.config.data[
                    "password"
                ]  # Store the raw password temporarily for hashing
                self.config.data["password"] = (
                    CipherManager.string_to_sha3_512_lowercase_hex(raw_password)
                )  # Hash the password

            login_successful, msg_login, self.config.data["cookie"] = (
                self.request_manager.login()
            )
            if login_successful:
                self.config.data["csrf_token"] = self.request_manager.get_csrf_token()
                ws_conn_successful, msg = self._get_ws_manager().connect()
                if ws_conn_successful:
                    self._get_ws_manager().is_login_phase = False
                    if self.config.data["cipher_enabled"]:
                        self.config.data["hashed_password"] = (
                            self.cipher_manager.hash_password(raw_password)
                        )
                    if self.config.data["cipher_enabled"] or not self.config.data["save_password"]:
                        self.config.data["password"] = ""
                    if display_login_success_dialog:
                        CustomDialog(
                            "Success! ClipCascade will now run in the task bar/menu bar.",
                            msg_type="success",
                            timeout=5000,
                        ).mainloop()
                    break
                else:
                    CustomDialog(
                        "Login successful but websocket connection failed. \nPlease check websocket-url\n"
                        + msg,
                        msg_type="error",
                    ).mainloop()
            else:
                CustomDialog("Login Failed\n" + msg_login, msg_type="error").mainloop()

            raw_password = None  # Clear the raw password
            if PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
                Echo("-" * 53)

    def _get_ws_manager(self):
        return self.transport_manager

    def get_version_update_status(self) -> list | None:
        """
        Checks for a new version of the application by comparing the current version
        with the one available in a remote JSON file.

        Returns:
        [Is new version available, latest version, current version, release URL],
        or None when the check fails.
        """
        try:
            response = RequestManager.get(VERSION_URL, timeout=(5, 10))
            response_data = response.json()
            if PLATFORM == WINDOWS:
                key = "windows"
            elif PLATFORM == MACOS:
                key = "macos"
            elif PLATFORM.startswith(LINUX):
                if not LINUX_USE_CLI_UI:
                    key = "linux_gui"
                else:
                    key = "linux_non_gui"

            latest_version = response_data[key]
            newer = parse_version(latest_version) > parse_version(APP_VERSION)
            return [newer, latest_version.strip(), APP_VERSION, RELEASE_URL]
        except Exception as e:
            logging.error(f"Error checking for new version: {e}")
        return None  # Unknown/offline: retain the last successful result.

    def get_donation_url(self) -> str:
        try:
            metadata = self.request_manager.get_metadata()
            if metadata is not None:
                return metadata.get("funding", None)
        except Exception as e:
            logging.error(f"Error fetching metadata: {e}")
        return None

    def logoff_and_exit(self):
        try:
            self._get_ws_manager().disconnect()
            self.request_manager.logout()
            self.config.data["hashed_password"] = None
            self.config.data["cookie"] = None
            self.config.data["maxsize"] = None
            self.config.data["password"] = ""
            self.config.data["csrf_token"] = ""
            self.config.save()
        except Exception as e:
            raise Exception(f"Error during logging off: {e}")

    def banner(self):
        if PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
            Echo(pyfiglet.figlet_format(APP_NAME))
            Echo("*" * 53)
            Echo("Real-Time Clipboard Syncing".center(53))
            Echo(GITHUB_URL.center(53))
            Echo("*" * 53)

    def _shutdown_macos(self, logoff=False):
        """Run on a worker while AppKit continues servicing native UI callbacks."""
        try:
            if logoff:
                self.logoff_and_exit()
            else:
                self._get_ws_manager().disconnect()
        finally:
            try:
                # Both managers are constructed at startup, even in relay mode.
                # Wait for P2P cleanup before stopping its asyncio worker.
                self.p2p_manager.shutdown()
            finally:
                self._cleanup_lock_file()
                self._macos_shutdown_complete = True

    def run(self):
        try:
            self.banner()
            self.setup_logging()
            self.ensure_single_instance()
            self.config.load()
            self.update_checker.start()
            self.authenticate_and_connect()
            self.config.save()
            donation_url = self.get_donation_url()

            sys_tray = TaskbarPanel(
                on_connect_callback=self._get_ws_manager().manual_reconnect,
                on_disconnect_callback=self._get_ws_manager().disconnect,
                on_logoff_callback=self.logoff_and_exit,
                new_version_available=self.update_checker.status,
                github_url=GITHUB_URL,
                donation_url=donation_url,
                ws_interface=self._get_ws_manager(),
                config=self.config,
                **({"on_shutdown_callback": self._shutdown_macos} if PLATFORM == MACOS else {}),
            )
            sys_tray.update_checker = self.update_checker
            self._get_ws_manager().set_tray_ref(sys_tray)
            sys_tray.run()
        except Exception as e:
            msg = f"An unexpected error has occurred: {e}"
            logging.error(msg)
            CustomDialog(
                msg + "\nCheck logs in project directory", msg_type="error"
            ).mainloop()
        finally:
            self.update_checker.stop()
            if not (PLATFORM == MACOS and self._macos_shutdown_complete):
                try:
                    self._get_ws_manager().disconnect()
                except Exception:
                    pass
                if PLATFORM == MACOS or PLATFORM.startswith(LINUX):
                    self._cleanup_lock_file()
