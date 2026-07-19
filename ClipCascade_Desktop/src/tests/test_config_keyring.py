"""Unit tests for desktop secret migration into the OS keyring."""

import base64
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# Allow imports from the desktop package root.
SRC_ROOT = Path(__file__).resolve().parents[1]
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from core.config import Config  # noqa: E402


class MemoryKeyring:
    """Minimal keyring backend for tests (no OS keychain dependency)."""

    class PasswordDeleteError(Exception):
        pass

    def __init__(self):
        self._store = {}

    def set_password(self, service, account, password):
        self._store[(service, account)] = password

    def get_password(self, service, account):
        return self._store.get((service, account))

    def delete_password(self, service, account):
        key = (service, account)
        if key not in self._store:
            raise MemoryKeyring.PasswordDeleteError("not found")
        del self._store[key]


class KeyringFailureTests(unittest.TestCase):
    """
    A keyring that cannot store must not cost the user their login.

    The migration used to strip secrets from the DATA file whether or not they
    reached the keyring, so on a box with no backend the only copy was deleted.
    """

    def setUp(self):
        self._dir = tempfile.mkdtemp()
        self.path = os.path.join(self._dir, "DATA")

    def tearDown(self):
        shutil.rmtree(self._dir, ignore_errors=True)

    def _legacy_data_file(self):
        with open(self.path, "w") as f:
            json.dump(
                {
                    "username": "u",
                    "server_url": "http://127.0.0.1:8080",
                    "cookie": {"JSESSIONID": "abc"},
                    "csrf_token": "tok",
                    "password": "pw",
                },
                f,
            )

    def test_secrets_survive_when_the_keyring_is_missing(self):
        self._legacy_data_file()
        config = Config(file_name=self.path)
        # Passing keyring_backend=None falls back to importing the real keyring,
        # so absence has to be simulated at the lookup itself.
        config._keyring = lambda: None
        config.load()
        config.save()

        with open(self.path) as f:
            on_disk = json.load(f)
        # Not silently discarded: the login still works after this.
        self.assertEqual(on_disk.get("csrf_token"), "tok")
        self.assertEqual(on_disk.get("password"), "pw")

    def test_secrets_survive_when_the_keyring_write_fails(self):
        self._legacy_data_file()

        class ExplodingKeyring:
            def get_password(self, service, account):
                return None

            def set_password(self, service, account, value):
                raise RuntimeError("no backend available")

            def delete_password(self, service, account):
                pass

        config = Config(file_name=self.path, keyring_backend=ExplodingKeyring())
        config.load()
        config.save()

        with open(self.path) as f:
            on_disk = json.load(f)
        self.assertEqual(on_disk.get("csrf_token"), "tok")
        self.assertEqual(on_disk.get("password"), "pw")


class ConfigKeyringTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.data_path = os.path.join(self._tmpdir.name, "DATA")
        self.keyring = MemoryKeyring()
        self.config = Config(file_name=self.data_path, keyring_backend=self.keyring)

    def tearDown(self):
        self._tmpdir.cleanup()

    def _read_data_file(self):
        with open(self.data_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def test_save_keeps_secrets_out_of_data_file(self):
        aes_key = os.urandom(32)
        self.config.data["username"] = "alice"
        self.config.data["server_url"] = "https://example.com"
        self.config.data["password"] = "sha3hash"
        self.config.data["csrf_token"] = "csrf-token"
        self.config.data["cookie"] = {"JSESSIONID": "abc123"}
        self.config.data["hashed_password"] = aes_key

        self.config.save()

        on_disk = self._read_data_file()
        for field in Config.SECRET_FIELDS:
            self.assertNotIn(field, on_disk)

        self.assertEqual(on_disk["username"], "alice")
        self.assertEqual(on_disk["server_url"], "https://example.com")

        # Secrets live only in the keyring.
        self.assertEqual(
            self.keyring.get_password(
                Config.KEYRING_SERVICE, self.config._secret_account("password")
            ),
            json.dumps("sha3hash"),
        )
        self.assertEqual(
            self.keyring.get_password(
                Config.KEYRING_SERVICE, self.config._secret_account("csrf_token")
            ),
            json.dumps("csrf-token"),
        )
        self.assertEqual(
            self.keyring.get_password(
                Config.KEYRING_SERVICE, self.config._secret_account("cookie")
            ),
            json.dumps({"JSESSIONID": "abc123"}),
        )
        self.assertEqual(
            self.keyring.get_password(
                Config.KEYRING_SERVICE, self.config._secret_account("hashed_password")
            ),
            base64.b64encode(aes_key).decode("utf-8"),
        )

    def test_load_restores_secrets_from_keyring(self):
        aes_key = os.urandom(32)
        self.config.data["username"] = "bob"
        self.config.data["password"] = "stored-pass"
        self.config.data["csrf_token"] = "csrf"
        self.config.data["cookie"] = {"JSESSIONID": "sess"}
        self.config.data["hashed_password"] = aes_key
        self.config.save()

        reloaded = Config(file_name=self.data_path, keyring_backend=self.keyring)
        self.assertTrue(reloaded.load())
        self.assertEqual(reloaded.data["username"], "bob")
        self.assertEqual(reloaded.data["password"], "stored-pass")
        self.assertEqual(reloaded.data["csrf_token"], "csrf")
        self.assertEqual(reloaded.data["cookie"], {"JSESSIONID": "sess"})
        self.assertEqual(reloaded.data["hashed_password"], aes_key)

        on_disk = self._read_data_file()
        for field in Config.SECRET_FIELDS:
            self.assertNotIn(field, on_disk)

    def test_migrates_legacy_secrets_from_data_file(self):
        aes_key = os.urandom(32)
        legacy = {
            "cipher_enabled": True,
            "server_url": "https://legacy.example",
            "username": "legacy-user",
            "password": "legacy-pass",
            "csrf_token": "legacy-csrf",
            "cookie": {"JSESSIONID": "legacy-session"},
            "hashed_password": base64.b64encode(aes_key).decode("utf-8"),
            "save_password": True,
            "salt": "s",
            "hash_rounds": 1000,
        }
        with open(self.data_path, "w", encoding="utf-8") as f:
            json.dump(legacy, f)

        loaded = Config(file_name=self.data_path, keyring_backend=self.keyring)
        self.assertTrue(loaded.load())

        self.assertEqual(loaded.data["username"], "legacy-user")
        self.assertEqual(loaded.data["password"], "legacy-pass")
        self.assertEqual(loaded.data["csrf_token"], "legacy-csrf")
        self.assertEqual(loaded.data["cookie"], {"JSESSIONID": "legacy-session"})
        self.assertEqual(loaded.data["hashed_password"], aes_key)

        on_disk = self._read_data_file()
        for field in Config.SECRET_FIELDS:
            self.assertNotIn(field, on_disk)
        self.assertEqual(on_disk["username"], "legacy-user")

        # Keyring holds migrated secrets.
        self.assertIsNotNone(
            self.keyring.get_password(
                Config.KEYRING_SERVICE, loaded._secret_account("password")
            )
        )
        self.assertIsNotNone(
            self.keyring.get_password(
                Config.KEYRING_SERVICE, loaded._secret_account("hashed_password")
            )
        )

    def test_clear_secrets_removes_keyring_entries(self):
        self.config.data["password"] = "p"
        self.config.data["csrf_token"] = "c"
        self.config.data["cookie"] = {"JSESSIONID": "j"}
        self.config.data["hashed_password"] = os.urandom(32)
        self.config.save()

        self.config.clear_secrets()
        self.config.save()

        for key in Config.SECRET_FIELDS:
            self.assertIsNone(
                self.keyring.get_password(
                    Config.KEYRING_SERVICE, self.config._secret_account(key)
                )
            )
        self.assertEqual(self.config.data["password"], "")
        self.assertEqual(self.config.data["csrf_token"], "")
        self.assertIsNone(self.config.data["cookie"])
        self.assertIsNone(self.config.data["hashed_password"])

    def test_empty_secrets_are_deleted_not_left_stale(self):
        self.config.data["password"] = "stale"
        self.config.data["csrf_token"] = "stale-csrf"
        self.config.save()

        self.config.data["password"] = ""
        self.config.data["csrf_token"] = ""
        self.config.save()

        self.assertIsNone(
            self.keyring.get_password(
                Config.KEYRING_SERVICE, self.config._secret_account("password")
            )
        )
        self.assertIsNone(
            self.keyring.get_password(
                Config.KEYRING_SERVICE, self.config._secret_account("csrf_token")
            )
        )


if __name__ == "__main__":
    unittest.main()
