"""One cancellable retry worker per connection manager."""
import logging
import random
import threading

from core.constants import (
    RECONNECT_WS_TIMER, RECONNECT_WS_MAX_TIMER,
    RECONNECT_WS_BACKOFF_MULTIPLIER, RECONNECT_WS_JITTER_RATIO,
)


class ReconnectMixin:
    def _init_reconnect(self):
        self._connect_lock = threading.Lock()
        self._retry_lock = threading.Lock()
        self._retry_stop = threading.Event()
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
        # Saturate before exponentiation, even after months offline.
        base = float(RECONNECT_WS_TIMER)
        for _ in range(min(self._reconnect_attempts, 64)):
            base = min(RECONNECT_WS_MAX_TIMER, base * RECONNECT_WS_BACKOFF_MULTIPLIER)
        jitter = base * RECONNECT_WS_JITTER_RATIO
        return min(RECONNECT_WS_MAX_TIMER, max(1.0, base + random.uniform(-jitter, jitter)))

    def _start_reconnect(self, immediate=False):
        with self._retry_lock:
            if self.disconnected or self.is_login_phase:
                return
            self._retry_stop.clear()
            if self._retry_thread is not None:
                return
            self.is_auto_reconnecting = True
            self._retry_thread = threading.Thread(target=self._retry_loop, args=(immediate,), daemon=True)
            self._retry_thread.start()

    def _retry_loop(self, immediate=False):
        try:
            while not self.disconnected and not self.is_connected:
                delay = 0 if immediate else self._next_reconnect_delay()
                immediate = False
                self._reconnect_attempts += 1
                logging.info("WebSocket reconnect attempt %d in %.1fs", self._reconnect_attempts, delay)
                if self._retry_stop.wait(delay):
                    break
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
        self.disconnected = True
        self.is_auto_reconnecting = False
        self._retry_stop.set()

    def manual_reconnect(self):
        self.disconnected = False
        self._reconnect_attempts = 0
        self._start_reconnect(immediate=True)
