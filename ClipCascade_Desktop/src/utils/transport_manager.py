"""Keep tray callbacks and reconnect workers stable across transport changes."""
import logging

from utils.reconnect import ReconnectMixin
from utils.server_discovery import discover_server


class TransportManager(ReconnectMixin):
    def __init__(self, config, request_manager, stomp, p2p):
        self.config = config
        self.request_manager = request_manager
        self.managers = {"P2S": stomp, "P2P": p2p}
        self.active = None
        self.disconnected = False
        self.is_login_phase = True
        self.is_auto_reconnecting = False
        self._init_reconnect()
        for manager in self.managers.values():
            manager.reconnect_handler = self._start_reconnect

    @property
    def is_connected(self):
        return self.active is not None and self.active.is_connected

    def _connect_once(self):
        try:
            discover_server(self.config, self.request_manager)
            if self.disconnected:
                return False, "Websocket disconnected"
            selected = self.managers[self.config.data["server_mode"]]
            if self.active is not None and self.active is not selected:
                old = self.active
                old.disconnect()
                # P2P cleanup is asynchronous; finish it before the new manager
                # installs clipboard listeners.
                pending = getattr(old, "_disconnect_future", None)
                if pending is not None:
                    pending.result(timeout=90)
            self.active = selected
            selected.disconnected = False
            if self.disconnected:
                selected.disconnect()
                return False, "Websocket disconnected"
            result = selected.connect()
            if self.disconnected:
                selected.disconnect()
                return False, "Websocket disconnected"
            if result[0]:
                selected.is_login_phase = False
                self.is_auto_reconnecting = False
                self._reconnect_attempts = 0
            return result
        except Exception as error:
            logging.warning("Server discovery/connection failed: %s", error)
            return False, str(error)

    def disconnect(self):
        self._stop_reconnect()
        if self.active is not None:
            self.active.disconnect()

    def set_tray_ref(self, tray):
        for manager in self.managers.values():
            manager.set_tray_ref(tray)

    def get_stats(self):
        if self.active is not None:
            return self.active.get_stats()
        return "Disconnected"

    def get_total_timeout(self):
        return max(manager.get_total_timeout() for manager in self.managers.values()) + 20000
