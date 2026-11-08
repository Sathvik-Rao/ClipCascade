"""Connection-scoped recipient snapshots; no clipboard contents or encryption keys."""
import re
import time
from threading import Lock

CONTROL = "relay-recipients"
TTL_SECONDS = 60


def split_recipients(snapshot):
    peers = snapshot.get("recipients")
    if snapshot.get("format") != "ccb1" or not isinstance(peers, list) or len(peers) > 256:
        return None
    if not all(isinstance(peer, dict) and isinstance(peer.get("id"), str)
               and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", peer["id"])
               and type(peer.get("binary")) is bool for peer in peers):
        return None
    if len({peer["id"] for peer in peers}) != len(peers):
        return None
    return {flag: [peer["id"] for peer in peers if peer["binary"] == flag] for flag in (False, True)}


class RelayRecipients:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._lock = Lock()
        self.reset()

    def reset(self):
        with self._lock:
            self._state = None

    def accept(self, message):
        """Consume reserved controls even if invalid; never treat them as clipboard data."""
        if not isinstance(message, dict) or message.get("_cc_control") != CONTROL:
            return False
        revision = message.get("revision")
        epoch = message.get("epoch")
        if (message.get("version") != 1 or type(revision) is not int or not 0 <= revision <= 2 ** 53 - 1
                or not isinstance(epoch, str) or not 1 <= len(epoch) <= 128):
            return True
        with self._lock:
            if self._state is not None:
                old_epoch, old_revision, _, _ = self._state
                if epoch != old_epoch or revision <= old_revision:
                    return True
            plan = split_recipients(message)
            # Invalid/oversized snapshots invalidate the old membership, allowing safe fallback.
            self._state = (epoch, revision, self._clock(), plan)
        return True

    def get(self):
        with self._lock:
            if self._state is None:
                return None
            _, _, received, plan = self._state
            if plan is None or self._clock() - received >= TTL_SECONDS:
                return None
            # Callers can adapt a representation without mutating the shared snapshot.
            return {flag: list(peers) for flag, peers in plan.items()}
