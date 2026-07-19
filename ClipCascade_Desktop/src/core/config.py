import base64
import ipaddress
import json
import logging
import os
import re
from urllib.parse import urlparse
from core.constants import *


class Config:
    SECRET_FIELDS = frozenset({"hashed_password", "cookie", "csrf_token", "password"})
    KEYRING_SERVICE = "ClipCascade"

    def __init__(self, file_name=DATA_FILE_NAME, keyring_backend=None):
        self.file_name = file_name
        self._keyring_backend = keyring_backend
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
            "save_password": False,
            "password": "",
            "max_clipboard_size_local_limit_bytes": MAX_SIZE,
            "enable_image_sharing": False,
            "enable_file_sharing": False,
            "default_file_download_location": "",
            "server_mode": "P2S",
            "stun_url": "",
            "ssl_ca_bundle": "",
            "device_id": "",
            "send_counter": 0,
            # Accept pre-3.2.0 (v1 / un-bound) messages. Off by default: v1 has
            # no counter, timestamp, or metadata binding, so allowing it lets
            # anyone who can inject into the transport strip the envelope and
            # replay old clipboard content. Enable only while some device in
            # the fleet still runs < 3.2.0.
            "allow_legacy_v1": False,
        }

    def save(self):
        """
        Persist non-secret settings to DATA file and secrets to the OS keyring.

        Only secrets that actually reached the keyring are stripped from the
        DATA file. Stripping unconditionally made the migration destructive:
        on a machine with no keyring backend (a headless Linux box, typically)
        the secrets went nowhere and were deleted from disk in the same pass,
        silently ending a working login with nothing but a warning in a log.
        """
        try:
            persisted = self._save_secrets()
            temp = {
                key: value
                for key, value in self.data.items()
                if key not in persisted
            }
            with open(self.file_name, "w") as f:
                json.dump(temp, f, indent=4)
            try:
                os.chmod(self.file_name, 0o600)
            except Exception:
                pass
        except Exception as e:
            logging.error(f"Failed to save data: {e}")

    def load(self):
        """
        Load non-secret settings from DATA file and secrets from the OS keyring.

        Legacy secrets still present in the DATA file are migrated into the keyring
        and scrubbed from disk on the next successful save.
        """
        if os.path.isfile(self.file_name):
            try:
                with open(self.file_name, "r") as f:
                    file_data = json.load(f)

                legacy_secrets = {
                    key: file_data[key] for key in self.SECRET_FIELDS if key in file_data
                }

                for key, value in file_data.items():
                    if key not in self.SECRET_FIELDS:
                        self.data[key] = value

                # Seed memory from legacy on-disk secrets (pre-keyring installs).
                if legacy_secrets.get("hashed_password"):
                    hashed = legacy_secrets["hashed_password"]
                    if isinstance(hashed, str):
                        self.data["hashed_password"] = base64.b64decode(hashed)
                    elif isinstance(hashed, bytes):
                        self.data["hashed_password"] = hashed
                for key in ("cookie", "csrf_token", "password"):
                    if key in legacy_secrets:
                        self.data[key] = legacy_secrets[key]

                # Keyring values take precedence over legacy file secrets.
                self._load_secrets()

                if legacy_secrets:
                    # Migrate: write secrets to keyring and rewrite DATA without them.
                    self.save()
                    logging.info(
                        "Migrated desktop secrets from DATA file into OS keyring"
                    )

                return True
            except Exception as e:
                logging.error(f"Failed to load data: {e}")
                logging.error(
                    "Try deleting DATA file in the program directory, and re-run the program again"
                )
        return False

    def clear_secrets(self):
        """Clear in-memory secrets and remove them from the OS keyring."""
        self.data["hashed_password"] = None
        self.data["cookie"] = None
        self.data["csrf_token"] = ""
        self.data["password"] = ""
        self._delete_all_secrets()

    def _secret_account(self, key: str) -> str:
        return f"{os.path.abspath(self.file_name)}:{key}"

    def _keyring(self):
        if self._keyring_backend is not None:
            return self._keyring_backend
        try:
            import keyring

            return keyring
        except Exception:
            return None

    def _is_empty_secret(self, key: str, value) -> bool:
        if value is None:
            return True
        if key == "password" and value == "":
            return True
        if key == "csrf_token" and value == "":
            return True
        if key == "cookie" and value in (None, "", {}):
            return True
        if key == "hashed_password" and value in (None, "", b""):
            return True
        return False

    def _serialize_secret(self, key: str, value) -> str:
        if key == "hashed_password":
            if isinstance(value, bytes):
                return base64.b64encode(value).decode("utf-8")
            if isinstance(value, str):
                # Already base64-encoded AES key material.
                return value
            raise TypeError(f"hashed_password must be bytes or str, got {type(value)}")
        return json.dumps(value)

    def _deserialize_secret(self, key: str, value: str):
        if key == "hashed_password":
            return base64.b64decode(value)
        return json.loads(value)

    def _save_secrets(self) -> set:
        """
        Write secrets to the OS keyring.

        Returns the keys that are safe to remove from the DATA file: those
        genuinely stored in the keyring, plus those that are empty and so have
        nothing to lose. A key missing from this set means the secret is NOT in
        the keyring, and the caller must leave whatever is on disk alone rather
        than deleting the only copy.
        """
        keyring = self._keyring()
        if keyring is None:
            has_secrets = any(
                not self._is_empty_secret(key, self.data.get(key))
                for key in self.SECRET_FIELDS
            )
            if has_secrets:
                logging.error(
                    "OS keyring unavailable: secrets cannot be stored securely. "
                    "Install a keyring backend (for example gnome-keyring or "
                    "kwallet); until then existing secrets are left as they are "
                    "on disk rather than being discarded."
                )
                # Nothing was persisted, so nothing may be stripped.
                return set()
            return set(self.SECRET_FIELDS)

        persisted = set()
        for key in self.SECRET_FIELDS:
            value = self.data.get(key)
            account = self._secret_account(key)
            if self._is_empty_secret(key, value):
                self._delete_secret(keyring, account)
                persisted.add(key)
                continue
            try:
                keyring.set_password(
                    self.KEYRING_SERVICE, account, self._serialize_secret(key, value)
                )
                persisted.add(key)
            except Exception as e:
                logging.error(
                    f"Could not save {key} to the OS keyring: {e}. Leaving the "
                    f"existing on-disk value in place rather than losing it."
                )
        return persisted

    def _load_secrets(self):
        keyring = self._keyring()
        if keyring is None:
            return

        for key in self.SECRET_FIELDS:
            account = self._secret_account(key)
            try:
                value = keyring.get_password(self.KEYRING_SERVICE, account)
            except Exception as e:
                logging.warning(f"Could not load {key} from OS keyring: {e}")
                continue
            if value is None:
                continue
            try:
                self.data[key] = self._deserialize_secret(key, value)
            except Exception as e:
                logging.warning(f"Could not decode {key} from OS keyring: {e}")

    def _delete_secret(self, keyring, account: str):
        try:
            keyring.delete_password(self.KEYRING_SERVICE, account)
        except Exception:
            # Entry may not exist; ignore.
            pass

    def _delete_all_secrets(self):
        keyring = self._keyring()
        if keyring is None:
            return
        for key in self.SECRET_FIELDS:
            self._delete_secret(keyring, self._secret_account(key))

    @staticmethod
    def _is_private_or_mesh_host(host: str) -> bool:
        """
        True for loopback, RFC1918 LAN, link-local, and Tailscale CGNAT / MagicDNS.

        Tailscale uses 100.64.0.0/10 (CGNAT) and *.ts.net MagicDNS names.
        HTTP over those is common for self-host; encryption is at the Tailscale wire.
        """
        if not host:
            return False
        host = host.lower().rstrip(".")
        if host == "localhost" or host.endswith(".localhost"):
            return True
        # Tailscale MagicDNS. Suffix only: "ts.net" itself is a real,
        # internet-routable domain, so treating the bare apex as mesh would
        # permit cleartext to a public host. Mobile networkPolicy.js has always
        # matched only the suffix; this keeps the two in step.
        if host.endswith(".ts.net"):
            return True
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return False
        # Python lists ::ffff:0:0/96 among the IPv6 private networks, so an
        # IPv4-mapped *public* address such as ::ffff:8.8.8.8 reports
        # is_private == True. Judge the embedded IPv4 address instead, or
        # http://[::ffff:8.8.8.8] would be accepted as a private host.
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None:
            ip = mapped
        if ip.is_loopback or ip.is_link_local or ip.is_private:
            return True
        # Tailscale CGNAT (also covered by is_private in Python 3 for 100.64/10?
        # CPython treats 100.64/10 as is_private=True since 3.8. Still be explicit.)
        if isinstance(ip, ipaddress.IPv4Address):
            if ip in ipaddress.ip_network("100.64.0.0/10"):
                return True
        return False

    @staticmethod
    def _allows_insecure_http(input_url: str) -> bool:
        parsed = urlparse(input_url)
        if parsed.scheme.lower() != "http":
            return True

        host = (parsed.hostname or "").lower()
        if os.environ.get("CLIPCASCADE_ALLOW_INSECURE_HTTP", "").lower() == "true":
            return True
        # Explicit opt-in for Tailscale/LAN HTTP (default: allow private/mesh hosts).
        allow_private = os.environ.get(
            "CLIPCASCADE_ALLOW_PRIVATE_HTTP", "true"
        ).lower()
        if allow_private in {"0", "false", "no"}:
            # Strict mode: only loopback unless ALLOW_INSECURE_HTTP.
            try:
                ip = ipaddress.ip_address(host)
                return ip.is_loopback
            except ValueError:
                return host == "localhost"

        return Config._is_private_or_mesh_host(host)

    @staticmethod
    def validate_server_url(input_url: str):
        if not input_url or not isinstance(input_url, str):
            raise ValueError("Invalid URL provided")

        # Normalise once and reuse. Passing the raw string on to the HTTP check
        # would re-parse it differently: urlparse(" http://evil.com") yields an
        # empty scheme, so the insecure-HTTP guard would not fire at all.
        normalized = re.sub(r"/+$", "", input_url.strip())
        parsed = urlparse(normalized)
        if not parsed.hostname:
            raise ValueError("Server URL must include a hostname")
        if parsed.username or parsed.password:
            raise ValueError("Server URL must not include embedded credentials")
        if parsed.query or parsed.fragment:
            raise ValueError("Server URL must not include query or fragment components")
        if parsed.path not in {"", "/"}:
            raise ValueError("Server URL must not include a path")
        if parsed.scheme.lower() not in {"http", "https"}:
            raise ValueError(f"Unsupported protocol in URL: {input_url}")
        if parsed.scheme.lower() == "http" and not Config._allows_insecure_http(
            normalized
        ):
            raise ValueError(
                "Refusing insecure HTTP for non-private server. "
                "Use HTTPS, a Tailscale/LAN address (100.x / *.ts.net / RFC1918), "
                "or set CLIPCASCADE_ALLOW_INSECURE_HTTP=true."
            )

    @staticmethod
    def convert_to_websocket_url(input_url: str, endpoint: str = None) -> str:
        # Trim whitespace and remove trailing slashes
        input_url = re.sub(r"/+$", "", input_url.strip())
        Config.validate_server_url(input_url)
        parsed = urlparse(input_url)

        # Determine protocol and convert
        if parsed.scheme.lower() == "https":
            ws_url = parsed._replace(scheme="wss").geturl()
        elif parsed.scheme.lower() == "http":
            ws_url = parsed._replace(scheme="ws").geturl()
        else:
            raise ValueError(f"Unsupported protocol in URL: {input_url}")

        if endpoint is not None:
            # Append the WebSocket endpoint and remove any trailing slash
            ws_url += endpoint
            ws_url = re.sub(r"/+$", "", ws_url)

        return ws_url
