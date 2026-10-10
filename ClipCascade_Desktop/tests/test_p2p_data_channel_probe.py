"""Regression: WebRTC data-channel probes carry messages without changing clipboard."""
from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from core import constants as clip_constants  # noqa: E402

clip_constants.LINUX_USE_CLI_UI = True
from p2p.p2p_manager import P2PManager  # noqa: E402


class FakeChannel:
    readyState = "open"

    def __init__(self) -> None:
        self.listeners: dict[str, object] = {}
        self.sent: list[str] = []

    def on(self, event: str):
        def register(listener):
            self.listeners[event] = listener
            return listener
        return register

    def send(self, value: str) -> None:
        self.sent.append(value)

    def emit(self, event: str, value: str) -> None:
        callback = self.listeners[event]
        callback(value)


class ProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = object.__new__(P2PManager)
        self.manager.data_channels = {}
        self.manager.dc_verified_at = {}
        self.manager.dc_probe_pending = {}
        self.manager.dc_first_probe_at = None
        self.manager._live_connections_lock = threading.Lock()
        self.manager.live_connections = 0
        self.manager._receive = Mock()
        self.channel = FakeChannel()
        self.manager.data_channels["phone"] = self.channel
        self.manager._setup_data_channel("phone", self.channel)

    def test_handler_attached_to_already_open_channel_counts_as_live(self) -> None:
        self.assertEqual(self.manager.live_connections, 1)

    def test_ping_gets_pong_without_touching_clipboard(self) -> None:
        self.channel.emit("message", json.dumps({"_cc_probe": "ping", "id": "fixture"}))
        self.assertEqual(json.loads(self.channel.sent[-1]), {"_cc_probe": "pong", "id": "fixture"})
        self.manager._receive.assert_not_called()

    def test_verified_pong_must_match_outstanding_challenge(self) -> None:
        self.manager.dc_probe_pending["phone"] = ("correct", time.monotonic())
        self.channel.emit("message", json.dumps({"_cc_probe": "pong", "id": "wrong"}))
        self.assertEqual(self.manager.dc_verified_at, {})
        self.channel.emit("message", json.dumps({"_cc_probe": "pong", "id": "correct"}))
        self.assertIn("phone", self.manager.dc_verified_at)
        self.assertNotIn("phone", self.manager.dc_probe_pending)
        self.manager._receive.assert_not_called()

    def test_actual_clipboard_packet_uses_existing_receive_path(self) -> None:
        packet = json.dumps({"type": "text", "payload": "fixture"})
        self.channel.emit("message", packet)
        self.manager._receive.assert_called_once_with(packet)


if __name__ == "__main__":
    unittest.main()
