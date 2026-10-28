import getpass
import os
import re

from core.config import Config
from cli.info import CustomDialog
from core.constants import *


class LoginForm:
    def __init__(
        self,
        config: Config,
        on_login_callback=None,
        on_quit_callback=None,
    ):
        self.config = config
        self.on_login_callback = on_login_callback
        self.on_quit_callback = on_quit_callback

    @staticmethod
    def remove_trailing_slash(entry):
        return re.sub(r"/+$", "", entry)

    @staticmethod
    def is_positive_integer(value):
        if value.isdigit() and int(value) > 0:
            return True
        else:
            return False

    @staticmethod
    def bool_to_str(value):
        return "y" if value else "n"

    @staticmethod
    def str_to_bool(value):
        return value.lower().strip() == "y"

    @staticmethod
    def is_positive_integer(value):
        if value.isdigit() and int(value) > 0:
            return True
        else:
            return False

    def mainloop(self):
        # save data to config
        self.config.data["username"] = (
            input(f"username [{self.config.data['username']}]: ")
            or self.config.data["username"]
        )

        self.config.data["password"] = getpass.getpass("password: ")

        server_url = (
            input(f"server url [{self.config.data['server_url']}]: ")
            or self.config.data["server_url"]
        )
        self.config.data["server_url"] = LoginForm.remove_trailing_slash(
            server_url.strip()
        )

        self.config.data["cipher_enabled"] = LoginForm.str_to_bool(
            input(
                f"Enable encryption (recommended) [{LoginForm.bool_to_str(self.config.data['cipher_enabled'])}]: "
            )
            or LoginForm.bool_to_str(self.config.data["cipher_enabled"])
        )

        self.config.data["notification"] = LoginForm.str_to_bool(
            input(
                f"Show connection status notifications [{LoginForm.bool_to_str(self.config.data['notification'])}]: "
            )
            or LoginForm.bool_to_str(self.config.data["notification"])
        )
        self._save_preference("notification")

        # extra fields
        show_extra_fields = input(f"Show advanced settings [n]: ") or "n"
        if not LoginForm.str_to_bool(show_extra_fields):
            CustomDialog("Logging in...").mainloop()
            return

        self.config.data["update_notifications"] = LoginForm.str_to_bool(
            input(
                f"Notify when an update is available [{LoginForm.bool_to_str(self.config.data['update_notifications'])}]: "
            ) or LoginForm.bool_to_str(self.config.data["update_notifications"])
        )
        self._save_preference("update_notifications")

        self.config.data["clipboard_notifications"] = LoginForm.str_to_bool(
            input(
                f"Notify when clipboard content is received (includes content previews) [{LoginForm.bool_to_str(self.config.data['clipboard_notifications'])}]: "
            ) or LoginForm.bool_to_str(self.config.data["clipboard_notifications"])
        )
        self._save_preference("clipboard_notifications")

        # Validate hash_rounds
        while True:
            hash_rounds = input(
                f"Key derivation iterations [{self.config.data['hash_rounds']}]: "
            ) or str(
                ""
                if self.config.data["hash_rounds"] is None
                else str(self.config.data["hash_rounds"])
            )
            hash_rounds = hash_rounds.strip()

            if not LoginForm.is_positive_integer(hash_rounds):
                CustomDialog(
                    "Invalid Input\nKey derivation iterations must be a positive integer.",
                    msg_type="error",
                )
                continue

            self.config.data["hash_rounds"] = int(hash_rounds)
            break

        self.config.data["salt"] = (
            input(f"Encryption salt [{self.config.data['salt']}]: ") or self.config.data["salt"]
        )

        self.config.data["save_password"] = LoginForm.str_to_bool(
            input(
                f"store password locally(not recommended; only works if encryption is disabled) [{LoginForm.bool_to_str(self.config.data['save_password'])}]: "
            )
            or LoginForm.bool_to_str(self.config.data["save_password"])
        )
        self._save_preference("save_password")

        # Validate max_clipboard_size_local_limit_bytes
        while True:
            saved_mcsll = str(
                ""
                if self.config.data["max_clipboard_size_local_limit_bytes"] is None
                else str(self.config.data["max_clipboard_size_local_limit_bytes"])
            )

            max_clipboard_size_local_limit_bytes = (
                input(
                    f"Local clipboard size limit (bytes) [{saved_mcsll}]: "
                )
                or saved_mcsll
            )
            max_clipboard_size_local_limit_bytes = (
                max_clipboard_size_local_limit_bytes.strip()
            )
            if max_clipboard_size_local_limit_bytes == "":
                self.config.data["max_clipboard_size_local_limit_bytes"] = None
                self._save_preference("max_clipboard_size_local_limit_bytes")
                break

            if not LoginForm.is_positive_integer(max_clipboard_size_local_limit_bytes):
                CustomDialog(
                    "Invalid Input\nLocal clipboard size limit must be a positive integer.",
                    msg_type="error",
                )
                continue

            self.config.data["max_clipboard_size_local_limit_bytes"] = int(
                max_clipboard_size_local_limit_bytes
            )
            self._save_preference("max_clipboard_size_local_limit_bytes")
            break

        for field, label in (
            ("send_clipboard", "Send clipboard"),
            ("receive_clipboard", "Receive clipboard"),
        ):
            self.config.data[field] = LoginForm.str_to_bool(
                input(f"{label} [{LoginForm.bool_to_str(self.config.data[field])}]: ")
                or LoginForm.bool_to_str(self.config.data[field])
            )
            self._save_preference(field)

        self.config.data["enable_image_sharing"] = LoginForm.str_to_bool(
            input(
                f"enable image sharing [{LoginForm.bool_to_str(self.config.data['enable_image_sharing'])}]: "
            )
            or LoginForm.bool_to_str(self.config.data["enable_image_sharing"])
        )
        self._save_preference("enable_image_sharing")

        self.config.data["enable_file_sharing"] = LoginForm.str_to_bool(
            input(
                f"enable file sharing [{LoginForm.bool_to_str(self.config.data['enable_file_sharing'])}]: "
            )
            or LoginForm.bool_to_str(self.config.data["enable_file_sharing"])
        )
        self._save_preference("enable_file_sharing")

        # Validate default file download location
        while True:
            default_file_download_location = (
                input(
                    f"Default download folder [{self.config.data['default_file_download_location']}]: "
                )
                or self.config.data["default_file_download_location"]
            )

            default_file_download_location = default_file_download_location.strip()
            if default_file_download_location == "":
                self.config.data["default_file_download_location"] = ""
                self._save_preference("default_file_download_location")
                break

            if not os.path.isdir(default_file_download_location):
                CustomDialog(
                    "Invalid directory path.",
                    msg_type="error",
                ).mainloop()
                continue

            self.config.data["default_file_download_location"] = (
                default_file_download_location
            )
            self._save_preference("default_file_download_location")
            break

        while True:
            ssl_ca_bundle = (
                input(
                    f"Custom CA certificate bundle path [{self.config.data.get('ssl_ca_bundle') or ''}]: "
                )
                or (self.config.data.get("ssl_ca_bundle") or "")
            ).strip()
            if ssl_ca_bundle == "":
                self.config.data["ssl_ca_bundle"] = ""
                break
            if not os.path.isfile(ssl_ca_bundle):
                CustomDialog(
                    "Invalid Input\nCustom CA certificate bundle path is not a file or does not exist.",
                    msg_type="error",
                ).mainloop()
                continue
            self.config.data["ssl_ca_bundle"] = ssl_ca_bundle
            break

        CustomDialog("Logging in...").mainloop()

    def _save_preference(self, field):
        if not self.config.save_preferences({field: self.config.data[field]}):
            CustomDialog("Unable to save device preferences.", msg_type="error").mainloop()

    def on_quit(self):
        pass

    def close(self):
        pass
