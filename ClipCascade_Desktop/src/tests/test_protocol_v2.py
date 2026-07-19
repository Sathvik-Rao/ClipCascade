"""Tests for protocol v2 envelope, AAD crypto, and replay cache."""

import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock

SRC_ROOT = Path(__file__).resolve().parents[1]
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from utils.protocol_v2 import (  # noqa: E402
    MAX_TRACKED_SENDERS,
    PROTOCOL_VERSION,
    ReplayCache,
    decrypt_legacy_blob,
    wrap_outbound,
    unwrap_inbound,
    build_aad,
)
from utils.stream_transfer import fragment_utf8_string, StreamAssembler  # noqa: E402
from utils.cipher_manager import CipherManager  # noqa: E402


class ProtocolV2Tests(unittest.TestCase):
    @staticmethod
    def _cipher():
        config = MagicMock()
        config.data = {
            "hashed_password": os.urandom(32),
            "username": "u",
            "salt": "s",
            "hash_rounds": 1,
        }
        return CipherManager(config), config

    def test_replay_cache_rejects_duplicates(self):
        cache = ReplayCache(max_entries=8)
        self.assertTrue(cache.accept("dev-a", 1))
        self.assertFalse(cache.accept("dev-a", 1))
        self.assertTrue(cache.accept("dev-a", 2))
        self.assertTrue(cache.accept("dev-b", 1))

    def test_wrap_and_unwrap_plain(self):
        store = {"device_id": "device-1", "send_counter": 0}
        env = wrap_outbound(
            payload="hello",
            payload_type="text",
            config_data=store,
            cipher_enabled=False,
        )
        self.assertEqual(env["v"], PROTOCOL_VERSION)
        self.assertEqual(env["senderDeviceId"], "device-1")
        self.assertEqual(env["counter"], 1)
        payload, ptype = unwrap_inbound(env, cipher_enabled=False, replay_cache=ReplayCache())
        self.assertEqual(payload, "hello")
        self.assertEqual(ptype, "text")

    def test_wrap_and_unwrap_encrypted_bound_metadata(self):
        key = os.urandom(32)
        config = MagicMock()
        config.data = {
            "hashed_password": key,
            "username": "u",
            "salt": "s",
            "hash_rounds": 1,
            "device_id": "dev-crypto",
            "send_counter": 0,
        }
        cipher = CipherManager(config)
        env = wrap_outbound(
            payload="secret-clip",
            payload_type="text",
            config_data=config.data,
            cipher_manager=cipher,
            cipher_enabled=True,
        )
        # Wire payload must use mobile-compatible bound blob
        blob = json.loads(env["payload"])
        self.assertTrue(blob.get("bound"))
        self.assertIn("nonce", blob)

        # Tampering with outer type must fail bound-metadata check
        bad = dict(env)
        bad["type"] = "image"
        with self.assertRaises(Exception):
            unwrap_inbound(
                bad,
                cipher_manager=cipher,
                cipher_enabled=True,
                replay_cache=ReplayCache(),
            )

        payload, ptype = unwrap_inbound(
            env,
            cipher_manager=cipher,
            cipher_enabled=True,
            replay_cache=ReplayCache(),
        )
        self.assertEqual(payload, "secret-clip")
        self.assertEqual(ptype, "text")

    def test_legacy_v1_rejected_by_default(self):
        """Stripping "v" must not be a way around the v2 checks."""
        body = {"payload": "legacy", "type": "text"}
        with self.assertRaises(ValueError):
            unwrap_inbound(body, cipher_enabled=False)

    def test_legacy_v1_accepted_only_when_opted_in(self):
        body = {"payload": "legacy", "type": "text"}
        payload, ptype = unwrap_inbound(
            body, cipher_enabled=False, allow_legacy_v1=True
        )
        self.assertEqual(payload, "legacy")
        self.assertEqual(ptype, "text")

    def test_v1_downgrade_of_a_v2_envelope_rejected(self):
        """A tamperer must not be able to replay a v2 ciphertext as v1."""
        cipher, config = self._cipher()
        env = wrap_outbound(
            payload="secret-clip",
            payload_type="text",
            config_data={"device_id": "sender", "send_counter": 0},
            cipher_manager=cipher,
            cipher_enabled=True,
        )
        downgraded = dict(env)
        del downgraded["v"]
        with self.assertRaises(ValueError):
            unwrap_inbound(
                downgraded,
                cipher_manager=cipher,
                cipher_enabled=True,
                replay_cache=ReplayCache(),
            )

    def test_unbound_ciphertext_rejected(self):
        """
        "bound" sits outside the AEAD, so it is attacker-mutable. Flipping it
        to false must not skip the metadata check.
        """
        cipher, config = self._cipher()
        env = wrap_outbound(
            payload="secret-clip",
            payload_type="text",
            config_data={"device_id": "sender", "send_counter": 0},
            cipher_manager=cipher,
            cipher_enabled=True,
        )
        blob = json.loads(env["payload"])
        blob["bound"] = False
        tampered = dict(env)
        tampered["payload"] = json.dumps(blob, separators=(",", ":"))
        tampered["senderDeviceId"] = "attacker-spoofed"
        tampered["counter"] = 9999
        with self.assertRaises(ValueError):
            unwrap_inbound(
                tampered,
                cipher_manager=cipher,
                cipher_enabled=True,
                replay_cache=ReplayCache(),
            )

    @staticmethod
    def _forged_envelope(sender, counter):
        """A v2 envelope whose ciphertext will not authenticate under our key."""
        return {
            "v": 2,
            "type": "text",
            "senderDeviceId": sender,
            "counter": counter,
            "ts": int(time.time() * 1000),
            "payload": json.dumps(
                {
                    "nonce": "AAAAAAAAAAAAAAAA",
                    "ciphertext": "AAAA",
                    "tag": "AAAAAAAAAAAAAAAAAAAAAA==",
                    "bound": True,
                },
                separators=(",", ":"),
            ),
        }

    def test_unauthenticated_flood_cannot_evict_replay_history(self):
        """
        Replay state is only touched after the AEAD verifies, so a peer without
        the key cannot evict a real sender's history and then replay its
        message.
        """
        cipher, _ = self._cipher()
        env = wrap_outbound(
            payload="secret-clip",
            payload_type="text",
            config_data={"device_id": "sender", "send_counter": 0},
            cipher_manager=cipher,
            cipher_enabled=True,
        )

        cache = ReplayCache()
        kwargs = dict(cipher_manager=cipher, cipher_enabled=True, replay_cache=cache)
        payload, _ = unwrap_inbound(dict(env), **kwargs)
        self.assertEqual(payload, "secret-clip")

        for i in range(512):
            with self.assertRaises(Exception):
                unwrap_inbound(self._forged_envelope(f"junk-{i}", 1), **kwargs)

        # The junk never entered the cache, so the real sender is still tracked
        # and its original message is still recognised as a replay.
        self.assertEqual(len(cache._senders), 1)
        with self.assertRaises(ValueError):
            unwrap_inbound(dict(env), **kwargs)

    def test_unauthenticated_message_cannot_pin_a_senders_counter(self):
        """
        Admitting an unverified counter would let one forged message push a
        victim's window far ahead and stall all of its real traffic.
        """
        cipher, _ = self._cipher()
        cache = ReplayCache()
        kwargs = dict(cipher_manager=cipher, cipher_enabled=True, replay_cache=cache)

        with self.assertRaises(Exception):
            unwrap_inbound(self._forged_envelope("sender", 2_000_000_000), **kwargs)

        env = wrap_outbound(
            payload="secret-clip",
            payload_type="text",
            config_data={"device_id": "sender", "send_counter": 0},
            cipher_manager=cipher,
            cipher_enabled=True,
        )
        payload, _ = unwrap_inbound(dict(env), **kwargs)
        self.assertEqual(payload, "secret-clip")

    def test_replay_cache_sender_count_is_bounded(self):
        cache = ReplayCache()
        for i in range(10_000):
            cache.accept(f"junk-device-{i}", 1)
        self.assertLessEqual(len(cache._senders), MAX_TRACKED_SENDERS)

    def test_replay_cache_rejects_bool_counter(self):
        cache = ReplayCache()
        self.assertFalse(cache.accept("dev", True))

    def test_replay_cache_rejects_out_of_range_counter(self):
        """
        Python ints are unbounded but JavaScript's are not. Accepting a huge
        counter would diverge from mobile and pin the sender's window, wedging
        that device until restart.
        """
        cache = ReplayCache()
        self.assertFalse(cache.accept("dev", 2**53))
        self.assertFalse(cache.accept("dev", 2**60))
        # The rejected values must not have pinned the window: this is the whole
        # point, since a pinned window rejects every later legitimate counter.
        self.assertTrue(cache.accept("dev", 5))
        # A large but still-safe counter remains acceptable.
        self.assertTrue(ReplayCache().accept("dev", 2**53 - 1))

    def test_unwrap_rejects_out_of_range_counter(self):
        env = {
            "v": 2,
            "type": "text",
            "senderDeviceId": "dev",
            "counter": 2**60,
            "ts": int(time.time() * 1000),
            "payload": "x",
        }
        with self.assertRaises(ValueError):
            unwrap_inbound(env, cipher_enabled=False, replay_cache=ReplayCache())

    def test_shared_cross_runtime_corpus(self):
        """
        Drive the shared corpus through the Python implementation.

        The mobile suite drives the same file through the JavaScript one. Both
        sides claimed to be behaviourally identical for three review rounds; the
        first time anyone measured it, they disagreed on 4 of 34 envelopes
        because of host-language differences (int/float, present-null) that are
        invisible when reading the two files side by side.
        """
        corpus = json.loads(
            (Path(__file__).parent / "protocol_corpus.json").read_text()
        )
        now = int(time.time() * 1000)
        for case in corpus["cases"]:
            with self.subTest(case=case["name"]):
                envelope = dict(case["envelope"])
                # 'ts: 0' in the file means "now"; a fixed value would age out
                # of the clock-skew window. Preserve the JSON type, or the
                # float case would either be rewritten into the int case or
                # fail on skew instead of on the property under test.
                ts = envelope.get("ts")
                if type(ts) is int and ts == 0:
                    envelope["ts"] = now
                elif type(ts) is float and ts == 0.0:
                    envelope["ts"] = float(now)
                if case["expect"] == "accept":
                    payload, _ = unwrap_inbound(
                        envelope, cipher_enabled=False, replay_cache=ReplayCache()
                    )
                    self.assertEqual(payload, envelope["payload"])
                else:
                    with self.assertRaises(ValueError):
                        unwrap_inbound(
                            envelope, cipher_enabled=False, replay_cache=ReplayCache()
                        )

    def test_emitted_nonce_is_12_bytes_for_ios_compatibility(self):
        """
        Apple's CryptoKit only accepts a 96-bit GCM nonce, so anything else is
        undecryptable on iOS. PyCryptodome defaults to 16 bytes when none is
        passed, which is how that incompatibility arose.
        """
        cipher, _ = self._cipher()
        for _ in range(5):
            self.assertEqual(len(cipher.encrypt("x")["nonce"]), 12)

        # Decryption must stay length-agnostic so messages from older desktop
        # builds (16-byte nonce) still open.
        legacy = cipher.encrypt("older-build")
        legacy_nonce = os.urandom(16)
        from Crypto.Cipher import AES

        c = AES.new(cipher.config.data["hashed_password"], AES.MODE_GCM, nonce=legacy_nonce)
        ct, tag = c.encrypt_and_digest(b"older-build")
        self.assertEqual(
            cipher.decrypt(nonce=legacy_nonce, ciphertext=ct, tag=tag), "older-build"
        )
        self.assertEqual(len(legacy["nonce"]), 12)

    def test_legacy_blob_refused_by_default(self):
        """
        A bare {nonce,ciphertext,tag} blob has no envelope, so none of the v2
        checks apply to it. It must be refused under the same opt-in as v1,
        otherwise every transport that can receive one reopens the bypass.
        """
        cipher, _ = self._cipher()
        encrypted = cipher.encrypt("legacy-secret")
        blob = CipherManager.encode_to_json_string(
            nonce=encrypted["nonce"],
            ciphertext=encrypted["ciphertext"],
            tag=encrypted["tag"],
        )

        with self.assertRaises(ValueError):
            decrypt_legacy_blob(blob, cipher_manager=cipher, allow_legacy_v1=False)

        self.assertEqual(
            decrypt_legacy_blob(blob, cipher_manager=cipher, allow_legacy_v1=True),
            "legacy-secret",
        )

    def test_self_originated_rejected(self):
        env = {
            "v": 2,
            "type": "text",
            "senderDeviceId": "me",
            "counter": 1,
            "ts": int(time.time() * 1000),
            "payload": "x",
        }
        with self.assertRaises(ValueError):
            unwrap_inbound(env, cipher_enabled=False, local_device_id="me")

    def test_build_aad_stable(self):
        aad = build_aad(2, "text", "d", 3, 100)
        self.assertEqual(aad, b"2|text|d|3|100")

    def test_fragment_utf8_preserves_multibyte(self):
        s = "hello 😀 world"
        parts = fragment_utf8_string(s, fragment_size=8)
        self.assertEqual("".join(parts), s)

    def test_stream_assembler_caps(self):
        asm = StreamAssembler("id", total_size=5, max_size=5)
        self.assertFalse(asm.add_chunk(0, b"hel"))
        self.assertTrue(asm.add_chunk(3, b"lo"))
        self.assertEqual(asm.assemble(), b"hello")
        with self.assertRaises(ValueError):
            StreamAssembler("id", total_size=10, max_size=5)

    def test_mobile_style_bound_blob_decrypts(self):
        """Desktop must accept the mobile bound ciphertext shape."""
        import base64

        key = os.urandom(32)
        config = MagicMock()
        config.data = {
            "hashed_password": key,
            "device_id": "desktop",
            "send_counter": 0,
        }
        cipher = CipherManager(config)
        sender = "mobile-device"
        counter = 7
        ts = int(time.time() * 1000)
        inner = json.dumps(
            {"t": "text", "d": sender, "c": counter, "ts": ts, "p": "from-mobile"},
            separators=(",", ":"),
        )
        enc = cipher.encrypt(inner)
        blob = {
            "nonce": base64.b64encode(enc["nonce"]).decode(),
            "ciphertext": base64.b64encode(enc["ciphertext"]).decode(),
            "tag": base64.b64encode(enc["tag"]).decode(),
            "bound": True,
        }
        env = {
            "v": 2,
            "type": "text",
            "senderDeviceId": sender,
            "counter": counter,
            "ts": ts,
            "payload": json.dumps(blob),
        }
        payload, ptype = unwrap_inbound(
            env,
            cipher_manager=cipher,
            cipher_enabled=True,
            replay_cache=ReplayCache(),
        )
        self.assertEqual(payload, "from-mobile")
        self.assertEqual(ptype, "text")


if __name__ == "__main__":
    unittest.main()
