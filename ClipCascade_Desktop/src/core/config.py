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
        "hide_login_success_dialog", "use_keyring",
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
            "use_keyring": False,
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

    @property
    def credentials_use_keyring(self):
        """Where the existing saved login lives, independently of the next choice."""
        return bool(self._secret_ref)

    def save(self, *, commit_storage=False):
        """
        Save login data, applying a pending storage choice only after manual login.
        Return False if preferences or credentials cannot be saved.
        """
        saved = self.data.copy()
        use_keyring = saved["use_keyring"] if commit_storage else self.credentials_use_keyring
        if not use_keyring:
            return self._save_data(saved, use_keyring=False)
        if not saved["cipher_enabled"]:
            saved["hashed_password"] = None
        if not saved["save_password"] or saved["cipher_enabled"]:
            saved["password"] = ""
        if self._save_data(saved, use_keyring=True):
            return True
        if self._secret_ref is None and not self._credentials_unavailable and not any(
            self._saved_data[key] for key in self.SECRET_FIELDS
        ) and any(
            saved[key] for key in self.SECRET_FIELDS
        ):
            # A desktop without an available keyring can still keep preferences.
            # Never use this fallback to overwrite credentials from an older install.
            saved.update(hashed_password=None, cookie=None, password="", csrf_token="")
            self._save_data(saved, use_keyring=True)
            # Saving preferences alone does not mean the login was saved.
            return False
        return False

    def save_preferences(self, updates):
        """Persist only device preferences, preserving the last saved login settings."""
        if not updates.keys() <= self.DEVICE_PREFERENCE_FIELDS:
            raise ValueError("Only device preferences can be saved independently")
        if updates.keys() == {"use_keyring"} or self._credentials_unavailable:
            # Preferences can still be saved while recovering a failed login.
            # Read the persisted document, not the incomplete saved snapshot or
            # a pending manual login. Keep its credential reference and login
            # fields intact, without accessing the unavailable credential store.
            try:
                if os.path.isfile(self.file_name):
                    with open(self.file_name, "r") as source:
                        saved = json.load(source)
                    saved.update(updates)
                    self._write_data_file(saved)
                    self._saved_data.update(updates)
                else:
                    saved = self._saved_data.copy()
                    saved.update(updates)
                    if not self._save_data(saved, use_keyring=self.credentials_use_keyring):
                        return False
                self.data.update(updates)
                return True
            except Exception as error:
                logging.error("Could not save device preferences (%s)", type(error).__name__)
                return False
        saved = self._saved_data.copy()
        saved.update(updates)
        if not saved["save_password"]:
            saved["password"] = ""
        if self._save_data(saved, use_keyring=self.credentials_use_keyring):
            self.data.update(updates)
            # Only the saved snapshot is cleared above. The CLI may already
            # hold a newly typed password needed for the pending login.
            return True
        return False

    def _write_data_file(self, data):
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", dir=os.path.dirname(os.path.abspath(self.file_name)), delete=False,
            ) as target:
                temporary_path = target.name
                json.dump(data, target, indent=4)
            os.replace(temporary_path, self.file_name)
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)

    def _save_data(self, data, *, use_keyring):
        # A failed read must not turn an empty in-memory login into deletion of
        # the existing entry. A successful manual login can save new secrets.
        if self._credentials_unavailable and not any(data[key] for key in self.SECRET_FIELDS):
            return False
        old_ref = self._secret_ref
        new_ref = old_ref
        store = None
        new_entry_written = False
        new_entry_verified = False
        try:
            temp = data.copy()
            secrets = {key: temp.pop(key) for key in self.SECRET_FIELDS}
            if not use_keyring:
                # Default desktop behavior: keep login data in DATA. Base64 is
                # only serialization for the derived key, not encryption.
                if isinstance(secrets["hashed_password"], bytes):
                    secrets["hashed_password"] = base64.b64encode(secrets["hashed_password"]).decode("ascii")
                temp.update(secrets)
                new_ref = None
            elif any(secrets.values()):
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
                    new_entry_written = True
                    if store.get_password(secret_storage.SERVICE, new_ref) != value:
                        raise RuntimeError("Credential store did not retain the new entry")
                    new_entry_verified = True
                temp["secret_ref"] = new_ref
            else:
                new_ref = None
            self._write_data_file(temp)
            self._secret_ref = new_ref
            self._credentials_unavailable = False
            self.credential_load_error = None
            self._saved_data = data.copy()
            if old_ref and old_ref != new_ref:
                self._delete_secret(old_ref, store)
            return True
        except Exception as e:
            # A failed access/verification may mean the user just denied a
            # prompt. Do not immediately ask again through a delete operation.
            if new_entry_verified:
                self._delete_secret(new_ref, store)
            elif new_entry_written:
                logging.warning(
                    "A new credential-store entry could not be verified; "
                    "leaving it untouched to avoid another access prompt"
                )
            logging.error("Could not save ClipCascade data (%s)", type(e).__name__)
            return False

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
        reading_keyring = False
        if os.path.isfile(self.file_name):
            try:
                with open(self.file_name, "r") as f:
                    file_data = json.load(f)
                self._secret_ref = file_data.pop("secret_ref", None)
                reading_keyring = self.credentials_use_keyring
                legacy = {key: file_data.pop(key) for key in self.SECRET_FIELDS if key in file_data}
                file_data.setdefault("use_keyring", False)
                self.data.update(file_data)
                loaded = self.data.copy()
                loaded.update(hashed_password=None, cookie=None, password="", csrf_token="")
                if not isinstance(loaded["use_keyring"], bool):
                    raise ValueError("Invalid credential storage preference")
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
                        else (
                            "Saved login data could not be read. The credential store may be locked, "
                            "access may have been denied or cancelled, or the saved data may be invalid."
                            if reading_keyring
                            else "The saved DATA file could not be read or contains invalid login data."
                        )
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
