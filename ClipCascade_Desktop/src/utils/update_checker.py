"""One immediate check, daily refreshes, and session-scoped update alerts."""
import logging
import re
import threading
import time


CHECK_INTERVAL = 24 * 60 * 60
RETRY_INTERVAL = 60 * 60


def parse_version(value):
    # Published client versions are stable major.minor.patch releases.
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value.strip()):
        raise ValueError("Invalid release version")
    return tuple(int(part) for part in value.strip().split("."))


class UpdateChecker:
    def __init__(self, fetch_status):
        self.fetch_status = fetch_status
        self.status = None
        self._lock = threading.Lock()
        self._alerted = set()
        self._stopped = threading.Event()
        self._thread = None

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, daemon=True, name="update-checker")
            self._thread.start()

    def stop(self):
        self._stopped.set()

    def claim_alert(self, enabled):
        """UI callers claim only after deciding how to present an alert."""
        with self._lock:
            if not enabled or not self.status or not self.status[0]:
                return None
            version = self.status[1]
            if version in self._alerted:
                return None
            self._alerted.add(version)
            return self.status.copy()

    def _run(self):
        while not self._stopped.is_set():
            interval = self._check_once()
            # Short waits also recover promptly after the computer wakes from sleep.
            deadline = time.time() + interval
            while not self._stopped.wait(min(60, max(0, deadline - time.time()))):
                if time.time() >= deadline:
                    break

    def _check_once(self):
        try:
            status = self.fetch_status()
            if status is not None:
                with self._lock:
                    self.status = status
                return CHECK_INTERVAL
        except Exception:
            logging.exception("Update check failed")
        return RETRY_INTERVAL
