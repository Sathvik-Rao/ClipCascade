import base64
import json
import os
import re
import tempfile
import uuid
from core.constants import *
from utils import secret_storage


class Config:
    SECRET_FIELDS = ("hashed_password", "cookie", "password", "csrf_token")
    DEVICE_PREFERENCE_FIELDS = frozenset({
        "notification", "update_notifications", "download_notifications", "clipboard_notifications", "save_password",
        "max_clipboard_size_local_limit_bytes", "clipboard_limit_display",
        "enable_image_sharing", "enable_file_sharing", "default_file_download_location",
        "send_clipboard", "receive_clipboard",
        "hide_login_success_dialog",
    })

    def __init__(self, file_name=DATA_FILE_NAME):
        self.file_name = file_name
        self.data = {
            "cipher_enabled": True,
            "server_url": "http://localhost:8080",
            "websocket_url": "",
            "username": "",
            "hashed_password": None,
            "cookie": None,
            "maxsize": None,
            "hash_rounds": 664937,
            "salt": "",
            "csrf_token": "",
            "notification": True,
            "update_notifications": True,
            "download_notifications": True,
            "clipboard_notifications": False,
            "hide_login_success_dialog": False,
            "save_password": False,
            "password": "",
            "max_clipboard_size_local_limit_bytes": None,
            "clipboard_limit_display": None,
            "send_clipboard": True,
            "receive_clipboard": True,
            "enable_image_sharing": True,
            "enable_file_sharing": True,
            "default_file_download_location": "",
            "server_mode": "P2S",
            "stun_url": "",
            "ssl_ca_bundle": "",
        }
        self._saved_data = self.data.copy()
        self._secret_ref = None
        self._credentials_unavailable = False
        self.credential_load_error = None

    def save(self):
        """
        Save preferences and credentials; return False if either cannot be saved.
        """
        saved = self.data.copy()
        if not saved["cipher_enabled"]:
            saved["hashed_password"] = None
        if not saved["save_password"] or saved["cipher_enabled"]:
            saved["password"] = ""
        if self._save_data(saved):
            return True
        if self._secret_ref is None and not self._credentials_unavailable and any(
            saved[key] for key in self.SECRET_FIELDS
        ):
            # A desktop without an available keyring can still keep preferences.
            # Never use this fallback to overwrite credentials from an older install.
            saved.update(hashed_password=None, cookie=None, password="", csrf_token="")
            self._save_data(saved)
            # Saving preferences alone does not mean the login was saved.
            return False
        return False

    def save_preferences(self, updates):
        """Persist only device preferences, preserving the last saved login settings."""
        if not updates.keys() <= self.DEVICE_PREFERENCE_FIELDS:
            raise ValueError("Only device preferences can be saved independently")
        if self._credentials_unavailable:
            return False
        saved = self._saved_data.copy()
        saved.update(updates)
        if not saved["save_password"]:
            saved["password"] = ""
        if self._save_data(saved):
            self.data.update(updates)
            if not saved["save_password"]:
                self.data["password"] = ""
            return True
        return False

    def _save_data(self, data):
        # A failed read must not turn an empty in-memory login into deletion of
        # the existing entry. A successful manual login can save new secrets.
        if self._credentials_unavailable and not any(data[key] for key in self.SECRET_FIELDS):
            return False
        temporary_path = None
        old_ref = self._secret_ref
        new_ref = old_ref
        store = None
        try:
            temp = data.copy()
            secrets = {key: temp.pop(key) for key in self.SECRET_FIELDS}
            if any(secrets.values()):
                if old_ref is None or self._credentials_unavailable or any(
                    data[key] != self._saved_data[key]
                    for key in (*self.SECRET_FIELDS, "server_url", "username")
                ):
                    if isinstance(secrets["hashed_password"], bytes):
                        secrets["hashed_password"] = base64.b64encode(secrets["hashed_password"]).decode("ascii")
                    store = secret_storage.backend()
                    new_ref = uuid.uuid4().hex
                    value = json.dumps({
                        "server_url": data["server_url"],
                        "username": data["username"],
                        "secrets": secrets,
                    })
                    store.set_password(secret_storage.SERVICE, new_ref, value)
                    if store.get_password(secret_storage.SERVICE, new_ref) != value:
                        raise RuntimeError("Credential store did not retain the new entry")
                temp["secret_ref"] = new_ref
            else:
                new_ref = None
            with tempfile.NamedTemporaryFile(
                mode="w", dir=os.path.dirname(os.path.abspath(self.file_name)),
                delete=False,
            ) as f:
                temporary_path = f.name
                json.dump(temp, f, indent=4)
            os.replace(temporary_path, self.file_name)
            self._secret_ref = new_ref
            self._credentials_unavailable = False
            self._saved_data = data.copy()
            if old_ref and old_ref != new_ref:
                self._delete_secret(old_ref, store)
            return True
        except Exception as e:
            if new_ref and new_ref != old_ref and store is not None:
                self._delete_secret(new_ref, store)
            logging.error("Could not save ClipCascade data securely (%s)", type(e).__name__)
            return False
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)

    @staticmethod
    def _delete_secret(ref, store=None):
        try:
            (store if store is not None else secret_storage.backend()).delete_password(
                secret_storage.SERVICE, ref
            )
        except Exception as e:
            logging.warning("Could not remove an old credential-store entry (%s)", type(e).__name__)

    def load(self):
        """
        Load data from file
        """
        self.credential_load_error = None
        if os.path.isfile(self.file_name):
            try:
                with open(self.file_name, "r") as f:
                    file_data = json.load(f)
                self._secret_ref = file_data.pop("secret_ref", None)
                legacy = {key: file_data.pop(key) for key in self.SECRET_FIELDS if key in file_data}
                self.data.update(file_data)
                loaded = self.data.copy()
                if self._secret_ref:
                    value = secret_storage.get_password(self._secret_ref)
                    if value is None:
                        self.credential_load_error = "The saved credential entry could not be found."
                        raise RuntimeError("Saved credentials are unavailable")
                    entry = json.loads(value)
                    if entry["server_url"] != loaded["server_url"] or entry["username"] != loaded["username"]:
                        self._secret_ref = None
                        raise ValueError("Saved credentials belong to a different login")
                    secrets = entry["secrets"]
                    loaded.update({key: secrets[key] for key in self.SECRET_FIELDS if key in secrets})
                else:
                    loaded.update(legacy)
                if loaded.get("hashed_password"):
                    loaded["hashed_password"] = base64.b64decode(loaded["hashed_password"])
                if legacy:
                    if not loaded["cipher_enabled"]:
                        loaded["hashed_password"] = None
                    if not loaded["save_password"] or loaded["cipher_enabled"]:
                        loaded["password"] = ""
                    if not self._save_data(loaded):
                        self._credentials_unavailable = True
                        self.credential_load_error = "Existing credentials could not be moved to secure storage."
                        self._saved_data = self.data.copy()
                        return False
                self.data = loaded
                self._saved_data = loaded.copy()
                self._credentials_unavailable = False
                return True
            except Exception as e:
                self._credentials_unavailable = True
                self.data.update(hashed_password=None, cookie=None, password="", csrf_token="")
                if self.credential_load_error is None:
                    self.credential_load_error = (
                        "The credential service is unavailable."
                        if secret_storage.is_service_unavailable(e)
                        else "Saved login data could not be read. The credential store may be locked, "
                             "access may have been denied or cancelled, or the saved data may be invalid."
                    )
                self._saved_data = self.data.copy()
                logging.warning("Could not load saved ClipCascade credentials (%s)", type(e).__name__)
        return False

    @staticmethod
    def convert_to_websocket_url(input_url: str, endpoint: str = None) -> str:
        if not input_url or not isinstance(input_url, str):
            raise ValueError("Invalid URL provided")

        # Trim whitespace, remove trailing slashes, and convert to lowercase
        input_url = re.sub(r"/+$", "", input_url.strip()).lower()

        # Determine protocol and convert
        if input_url.startswith("https://"):
            ws_url = input_url.replace("https://", "wss://", 1)
        elif input_url.startswith("http://"):
            ws_url = input_url.replace("http://", "ws://", 1)
        else:
            raise ValueError(f"Unsupported protocol in URL: {input_url}")

        if endpoint is not None:
            # Append the WebSocket endpoint and remove any trailing slash
            ws_url += endpoint
            ws_url = re.sub(r"/+$", "", ws_url)

        return ws_url
