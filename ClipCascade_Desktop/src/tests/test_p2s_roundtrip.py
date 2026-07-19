"""
Client -> server -> client round trip over the P2S (STOMP) transport.

The server is a relay: ClipCascadeController.sendPrivateMessage rebuilds the
outgoing message from exactly three getters on ClipboardData, so any top-level
field the client invents is dropped in transit. Protocol v2 shipped four such
fields, which meant every relayed message arrived looking like legacy v1 and was
refused — default sync was broken and no test noticed, because the desktop suite
stopped at unwrap_inbound, the mobile suite stopped at unwrapInbound, and the
server suite never touched /cliptext.

These tests model the relay's lossiness and drive the real client code through
it, so the gap between "both ends agree" and "a message survives the middle" is
covered.
"""

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

from utils.cipher_manager import CipherManager  # noqa: E402
from utils.protocol_v2 import (  # noqa: E402
    ReplayCache,
    build_transport_frame,
    extract_transport_envelope,
    unwrap_inbound,
    wrap_outbound,
)


def relay(frame: dict) -> dict:
    """
    Reproduce ClipCascadeController.sendPrivateMessage verbatim.

    Java, for reference:

        ClipboardData messageToSend = new ClipboardData(
                clipboardData.getPayload(),
                (clipboardData.getType() == null) ? "text" : clipboardData.getType(),
                clipboardData.getMetadata());

    Three getters survive; everything else the client sent is discarded, both by
    this server and by every older one already deployed.
    """
    return {
        "payload": frame.get("payload"),
        "type": frame.get("type") or "text",
        "metadata": frame.get("metadata"),
    }


class P2SRoundTripTests(unittest.TestCase):
    def setUp(self):
        config = MagicMock()
        config.data = {
            "hashed_password": os.urandom(32),
            "username": "u",
            "salt": "s",
            "hash_rounds": 1,
        }
        self.cipher = CipherManager(config)

    def _send(self, payload, payload_type="text", cipher_enabled=True):
        """Sender side, exactly as stomp_manager.send builds it."""
        envelope = wrap_outbound(
            payload=payload,
            payload_type=payload_type,
            config_data={"device_id": "device-A", "send_counter": 0},
            cipher_manager=self.cipher,
            cipher_enabled=cipher_enabled,
        )
        return build_transport_frame(envelope, payload_type=payload_type)

    def _receive(self, relayed, *, replay_cache=None, cipher_enabled=True, **kwargs):
        """Receiver side, exactly as stomp_manager._receive consumes it."""
        envelope = extract_transport_envelope(relayed)
        return unwrap_inbound(
            envelope,
            cipher_manager=self.cipher,
            cipher_enabled=cipher_enabled,
            replay_cache=replay_cache if replay_cache is not None else ReplayCache(),
            local_device_id="device-B",
            **kwargs,
        )

    def test_frame_contains_only_fields_the_server_models(self):
        """
        The server does not ignore unknown top-level keys — Jackson raises
        UnrecognizedPropertyException and the message is dropped before the
        handler runs. Verified against a real server: publishing the flat
        envelope relayed nothing at all.

        So the outgoing frame must carry exactly the fields ClipboardData
        declares, and nothing else, however harmless the extra looks.
        """
        server_known_fields = {"payload", "type", "metadata"}
        frame = self._send("secret-clip")
        self.assertTrue(
            set(frame).issubset(server_known_fields),
            f"frame has fields the server will reject: {set(frame) - server_known_fields}",
        )

    def test_relay_drops_unknown_top_level_fields(self):
        """
        Pins the assumption the whole design rests on. If a future server learns
        to carry the envelope fields, this is the test that says the nesting is
        no longer required.
        """
        flat = {
            "v": 2,
            "type": "text",
            "senderDeviceId": "device-A",
            "counter": 1,
            "ts": int(time.time() * 1000),
            "payload": "x",
        }
        relayed = relay(flat)
        for dropped in ("v", "senderDeviceId", "counter", "ts"):
            self.assertNotIn(dropped, relayed)

    def test_roundtrip_survives_the_relay(self):
        """The regression test for F0. Fails before the transport frame exists."""
        frame = self._send("secret-clip")
        relayed = relay(json.loads(json.dumps(frame)))
        payload, payload_type = self._receive(relayed, allow_legacy_v1=False)
        self.assertEqual(payload, "secret-clip")
        self.assertEqual(payload_type, "text")

    def test_roundtrip_survives_the_relay_cipher_off(self):
        frame = self._send("plain-clip", cipher_enabled=False)
        relayed = relay(json.loads(json.dumps(frame)))
        payload, _ = self._receive(
            relayed, cipher_enabled=False, allow_legacy_v1=False
        )
        self.assertEqual(payload, "plain-clip")

    def test_payload_type_survives_the_relay(self):
        for payload_type in ("text", "image", "files"):
            with self.subTest(payload_type=payload_type):
                frame = self._send("blob", payload_type=payload_type)
                relayed = relay(json.loads(json.dumps(frame)))
                _, received_type = self._receive(relayed, allow_legacy_v1=False)
                self.assertEqual(received_type, payload_type)

    def test_outer_type_is_not_trusted(self):
        """
        The outer frame is unauthenticated. Only the type bound inside the
        ciphertext may win, or the relay could re-label text as files and steer
        the receiver down a different handler.
        """
        frame = self._send("secret-clip", payload_type="text")
        relayed = relay(json.loads(json.dumps(frame)))
        relayed["type"] = "files"
        payload, received_type = self._receive(relayed, allow_legacy_v1=False)
        self.assertEqual(received_type, "text")
        self.assertEqual(payload, "secret-clip")

    def test_replay_through_the_relay_is_rejected(self):
        frame = self._send("secret-clip")
        relayed = relay(json.loads(json.dumps(frame)))
        cache = ReplayCache()
        self._receive(relayed, replay_cache=cache, allow_legacy_v1=False)
        with self.assertRaises(ValueError):
            self._receive(relayed, replay_cache=cache, allow_legacy_v1=False)

    def test_self_originated_message_ignored_through_the_relay(self):
        envelope = wrap_outbound(
            payload="mine",
            payload_type="text",
            config_data={"device_id": "device-B", "send_counter": 0},
            cipher_manager=self.cipher,
            cipher_enabled=True,
        )
        relayed = relay(build_transport_frame(envelope, payload_type="text"))
        with self.assertRaises(ValueError):
            self._receive(relayed, allow_legacy_v1=False)

    def test_legacy_bare_blob_through_relay_still_refused(self):
        """
        Guards the side door that was closed once already: the extractor must
        not become a new way in for un-versioned ciphertext.
        """
        blob = CipherManager.encode_to_json_string(**self.cipher.encrypt("legacy"))
        relayed = relay({"payload": blob, "type": "text"})
        with self.assertRaises(ValueError):
            self._receive(relayed, allow_legacy_v1=False)

    def test_flat_envelope_still_accepted(self):
        """
        Forward compatibility: if a server ever does carry the envelope fields,
        the client must keep working without a coordinated release.
        """
        envelope = wrap_outbound(
            payload="direct",
            payload_type="text",
            config_data={"device_id": "device-A", "send_counter": 0},
            cipher_manager=self.cipher,
            cipher_enabled=True,
        )
        payload, _ = self._receive(envelope, allow_legacy_v1=False)
        self.assertEqual(payload, "direct")

    def test_garbage_frames_raise_value_error(self):
        """Never leak a JSONDecodeError; callers catch ValueError."""
        for bad in ({"payload": "not json"}, {"payload": 5}, {"payload": "[]"}, {}):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    extract_transport_envelope(bad)


if __name__ == "__main__":
    unittest.main()
