"""One cancellable retry worker per connection manager."""
import logging
import random
import threading

from core.constants import (
    RECONNECT_WS_TIMER, RECONNECT_WS_JITTER_RATIO,
)


class ReconnectMixin:
    def _init_reconnect(self):
        self._connect_lock = threading.Lock()
        self._retry_lock = threading.Lock()
        self._retry_wake = threading.Event()
        self._retry_thread = None
        self._reconnect_attempts = 0

    def connect(self):
        # A close callback can arrive while the caller is still connecting.
        # Its retry worker must wait until that attempt has finished cleaning up.
        with self._connect_lock:
            if self.disconnected:
                return False, "Websocket disconnected"
            return self._connect_once()

    def _next_reconnect_delay(self):
        if self._reconnect_attempts == 0:
            return 0.0
        # Keep retries responsive throughout an outage, spreading clients with jitter.
        base = float(RECONNECT_WS_TIMER)
        jitter = base * RECONNECT_WS_JITTER_RATIO
        return max(1.0, base + random.uniform(-jitter, jitter))

    def _start_reconnect(self, immediate=False):
        with self._retry_lock:
            if self.disconnected or self.is_login_phase:
                return
            if self._retry_thread is not None:
                if immediate:
                    self._reconnect_attempts = 0
                    self._retry_wake.set()
                return
            self._retry_wake.clear()
            self.is_auto_reconnecting = True
            self._retry_thread = threading.Thread(target=self._retry_loop, daemon=True)
            self._retry_thread.start()

    def _retry_loop(self):
        try:
            while not self.disconnected and not self.is_connected:
                with self._retry_lock:
                    delay = self._next_reconnect_delay()
                    attempt = self._reconnect_attempts + 1
                logging.info("WebSocket reconnect attempt %d in %.1fs", attempt, delay)
                self._retry_wake.wait(delay)
                with self._retry_lock:
                    self._retry_wake.clear()
                    if self.disconnected or self.is_connected:
                        break
                    self._reconnect_attempts += 1
                try:
                    self.connect()
                except Exception:
                    logging.exception("WebSocket reconnect attempt failed")
        finally:
            with self._retry_lock:
                self._retry_thread = None
                self.is_auto_reconnecting = False
            # Cover a close arriving as the successful worker was exiting.
            if not self.disconnected and not self.is_connected:
                self._start_reconnect()

    def _stop_reconnect(self):
        with self._retry_lock:
            self.disconnected = True
            self.is_auto_reconnecting = False
            self._retry_wake.set()

    def manual_reconnect(self):
        with self._retry_lock:
            self.disconnected = False
            self._reconnect_attempts = 0
        self._start_reconnect(immediate=True)
