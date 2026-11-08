"""Recognize encrypted P2S echoes from legacy servers without storing payloads."""
from collections import OrderedDict
from threading import Lock


class ClipboardEchoes:
    def __init__(self):
        self._pending = OrderedDict()
        self._lock = Lock()

    def remember(self, key):
        with self._lock:
            self._pending[key] = self._pending.get(key, 0) + 1
            while len(self._pending) > 1024:
                self._pending.popitem(last=False)

    def consume(self, key):
        with self._lock:
            count = self._pending.get(key, 0)
            if not count:
                return False
            if count == 1:
                del self._pending[key]
            else:
                self._pending[key] = count - 1
            return True
