"""E2E clipboard protocol v2: device ID, counters, bound metadata, replay cache.

Wire format (cipher on) is shared with mobile:
  outer envelope: {v, type, senderDeviceId, counter, ts, payload}
  payload (JSON string): {nonce, ciphertext, tag, bound: true}
  ciphertext plaintext: {t, d, c, ts, p}  # binds outer metadata

AES-GCM AAD is not used for cross-client compatibility (RN AES-GCM has no AAD).
"""

from __future__ import annotations

import base64
import json
import time
import uuid
from collections import OrderedDict
from typing import Any, Optional

PROTOCOL_VERSION = 2
REPLAY_CACHE_MAX = 2048
MAX_TRACKED_SENDERS = 64
MAX_CLOCK_SKEW_MS = 10 * 60 * 1000  # 10 minutes
MIN_COUNTER = 1
# Mirrors JavaScript's Number.MAX_SAFE_INTEGER. Python ints are unbounded, so
# without this the two implementations disagree on huge counters, and one
# absurd value would pin a sender's window (every later counter then fails the
# "counter <= last - max" check) and wedge that device until restart.
MAX_COUNTER = 2**53 - 1


class ReplayCache:
    """
    Rejects duplicate (sender_device_id, counter) pairs within a bounded window.

    The window is kept per sender: a shared window lets one sender's traffic
    evict another's history, which would let a replayed message back in. Both
    the per-sender window and the number of tracked senders are bounded so a
    flood of unique device IDs cannot grow memory without limit.

    Callers must only admit senders whose message has already been
    authenticated (see unwrap_inbound); otherwise an unauthenticated peer can
    both evict real entries and pin a victim's counter.
    """

    def __init__(
        self,
        max_entries: int = REPLAY_CACHE_MAX,
        max_senders: int = MAX_TRACKED_SENDERS,
    ):
        self._max = max_entries
        self._max_senders = max_senders
        # sender_device_id -> {"seen": OrderedDict[int, None], "last": int | None}
        self._senders: OrderedDict[str, dict] = OrderedDict()

    def accept(self, sender_device_id: str, counter: int) -> bool:
        # bool is a subclass of int; reject it explicitly.
        if (
            not sender_device_id
            or isinstance(counter, bool)
            or not isinstance(counter, int)
            or counter < MIN_COUNTER
            or counter > MAX_COUNTER
        ):
            return False

        entry = self._senders.get(sender_device_id)
        if entry is None:
            entry = {"seen": OrderedDict(), "last": None}
            self._senders[sender_device_id] = entry
            while len(self._senders) > self._max_senders:
                self._senders.popitem(last=False)
        self._senders.move_to_end(sender_device_id)

        seen = entry["seen"]
        if counter in seen:
            return False
        last = entry["last"]
        if last is not None and counter <= last - self._max:
            return False

        seen[counter] = None
        while len(seen) > self._max:
            seen.popitem(last=False)
        if last is None or counter > last:
            entry["last"] = counter
        return True


def build_aad(
    version: int,
    payload_type: str,
    sender_device_id: str,
    counter: int,
    ts_ms: int,
) -> bytes:
    """Canonical metadata string (used for binding docs/tests; not GCM AAD on wire)."""
    return f"{version}|{payload_type}|{sender_device_id}|{counter}|{ts_ms}".encode(
        "utf-8"
    )


def ensure_device_id(config_data: dict) -> str:
    device_id = config_data.get("device_id")
    if not device_id or not isinstance(device_id, str):
        device_id = str(uuid.uuid4())
        config_data["device_id"] = device_id
    return device_id


def next_counter(config_data: dict) -> int:
    counter = int(config_data.get("send_counter") or 0) + 1
    config_data["send_counter"] = counter
    return counter


def wrap_outbound(
    *,
    payload: str,
    payload_type: str,
    config_data: dict,
    cipher_manager=None,
    cipher_enabled: bool = False,
) -> dict[str, Any]:
    """Build a v2 transport envelope. Encrypts payload when cipher is enabled."""
    device_id = ensure_device_id(config_data)
    counter = next_counter(config_data)
    ts_ms = int(time.time() * 1000)

    wire_payload = payload
    if cipher_enabled and cipher_manager is not None:
        # Bind metadata inside ciphertext (compatible with mobile protocolV2.js).
        inner = json.dumps(
            {
                "t": payload_type,
                "d": device_id,
                "c": counter,
                "ts": ts_ms,
                "p": payload,
            },
            separators=(",", ":"),
        )
        encrypted = cipher_manager.encrypt(inner)  # no AAD — mobile interop
        blob = {
            "nonce": base64.b64encode(encrypted["nonce"]).decode("utf-8"),
            "ciphertext": base64.b64encode(encrypted["ciphertext"]).decode("utf-8"),
            "tag": base64.b64encode(encrypted["tag"]).decode("utf-8"),
            "bound": True,
        }
        wire_payload = json.dumps(blob, separators=(",", ":"))

    return {
        "v": PROTOCOL_VERSION,
        "type": payload_type,
        "senderDeviceId": device_id,
        "counter": counter,
        "ts": ts_ms,
        "payload": wire_payload,
    }


def _as_wire_int(value):
    """
    Interpret a JSON number as an integer the way JavaScript must, or None.

    json.loads keeps 5 and 5.0 apart; JSON.parse cannot — both become the same
    JS number, so mobile has no way to reject the second. Rather than let the
    two runtimes accept different envelopes off the same wire, treat a
    whole-valued float as the integer it denotes, and reject anything with a
    fractional part on both sides. bool is excluded because it is a subclass of
    int in Python.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def build_transport_frame(envelope: dict, *, payload_type: str) -> dict:
    """
    Wrap a v2 envelope in the outer frame the server relays.

    The server models a clipboard message as {payload, type, metadata} and
    rebuilds the relayed copy from exactly those three fields, so any other
    top-level key is dropped in transit. Serialising the envelope into `payload`
    keeps it intact through every server, including versions that predate
    protocol v2 — which is what most self-hosters are running.

    This is also what the P2P transport has always done, so both transports now
    put the same bytes on the wire.

    Only the fields the server models are sent. It does not merely ignore extra
    top-level keys — Jackson raises UnrecognizedPropertyException and the whole
    message is dropped before the handler ever runs, which is why the flat
    envelope did not just arrive looking like v1, it never arrived at all.
    """
    return {
        "payload": json.dumps(envelope, separators=(",", ":")),
        "type": payload_type,
    }


def extract_transport_envelope(body: dict) -> dict:
    """
    Recover the v2 envelope from a relayed frame.

    Accepts the frame produced by build_transport_frame, and also a flat
    envelope, so the client keeps working if a server ever starts carrying the
    envelope fields itself.

    The outer frame's `type` and `metadata` are attacker- or relay-controlled
    and are deliberately NOT returned: only the envelope reaches unwrap_inbound,
    and only the type bound inside the ciphertext is authoritative.

    Raises ValueError (never JSONDecodeError) so callers have one thing to
    catch.
    """
    if not isinstance(body, dict):
        raise ValueError("Invalid clipboard frame")

    # Already flat: either a future server that carries the envelope, or a
    # caller handing us an envelope directly.
    if body.get("v") == PROTOCOL_VERSION and "senderDeviceId" in body:
        return body

    payload = body.get("payload")
    if not isinstance(payload, str):
        raise ValueError(
            "Clipboard frame has no string payload to unwrap "
            f"(keys: {sorted(body)})"
        )

    try:
        envelope = json.loads(payload)
    except json.JSONDecodeError as e:
        # A bare legacy ciphertext blob also lands here when it is not JSON.
        raise ValueError(f"Clipboard frame payload is not a v2 envelope: {e}") from e

    if not isinstance(envelope, dict) or "payload" not in envelope:
        raise ValueError("Clipboard frame payload is not a v2 envelope")

    return envelope


def unwrap_inbound(
    body: dict,
    *,
    cipher_manager=None,
    cipher_enabled: bool = False,
    replay_cache: Optional[ReplayCache] = None,
    local_device_id: Optional[str] = None,
    allow_legacy_v1: bool = False,
) -> tuple[str, str]:
    """
    Parse inbound message (v1 or v2). Returns (payload, payload_type).

    Raises ValueError on replay, bad binding, or malformed envelope.

    v1 carries no counter, timestamp, or metadata binding, so accepting it
    lets anyone who can inject into the transport strip the "v" field and
    bypass every v2 protection. v1 is therefore refused unless the caller
    opts in via allow_legacy_v1 (for mixed fleets still running < 3.2.0).
    """
    if not isinstance(body, dict) or "payload" not in body:
        raise ValueError("Invalid clipboard message")

    version = body.get("v", 1)
    payload_type = body.get("type", "text")
    payload = body["payload"]

    # Legacy v1: {"payload": ..., "type": ...}
    if version == 1 or version is None:
        if not allow_legacy_v1:
            raise ValueError(
                "Rejected legacy v1 message (no replay or metadata binding). "
                "Upgrade all devices to 3.2.0+, or set allow_legacy_v1."
            )
        if cipher_enabled and cipher_manager is not None:
            from utils.cipher_manager import CipherManager

            if isinstance(payload, str):
                payload = cipher_manager.decrypt(
                    **CipherManager.decode_from_json_string(payload)
                )
        return payload, payload_type

    if version != PROTOCOL_VERSION:
        raise ValueError(f"Unsupported protocol version: {version}")

    sender = body.get("senderDeviceId")
    counter = body.get("counter")
    ts_ms = body.get("ts")
    if not isinstance(sender, str) or not sender:
        raise ValueError("Missing senderDeviceId")
    counter = _as_wire_int(counter)
    if counter is None or counter < MIN_COUNTER or counter > MAX_COUNTER:
        raise ValueError("Invalid counter")
    ts_ms = _as_wire_int(ts_ms)
    if ts_ms is None:
        raise ValueError("Invalid timestamp")

    now = int(time.time() * 1000)
    if abs(now - ts_ms) > MAX_CLOCK_SKEW_MS:
        raise ValueError("Message timestamp outside allowed skew")

    if local_device_id and sender == local_device_id:
        raise ValueError("Ignoring self-originated message")

    if cipher_enabled and cipher_manager is None:
        # Fail closed. Returning the payload here would hand back ciphertext as
        # if it were plaintext, with no decrypt, no binding check and no
        # integrity at all — the exact opposite of what cipher_enabled asks for.
        raise ValueError("Encryption is enabled but no cipher is configured")

    if cipher_enabled and cipher_manager is not None:
        if not isinstance(payload, str):
            raise ValueError("Encrypted payload must be a string")
        try:
            blob = json.loads(payload)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid encrypted payload JSON: {e}") from e

        nonce = blob.get("nonce")
        ciphertext = blob.get("ciphertext")
        tag = blob.get("tag")
        if not all(isinstance(x, str) for x in (nonce, ciphertext, tag)):
            raise ValueError("Encrypted payload missing base64 fields")

        plain = cipher_manager.decrypt(
            nonce=base64.b64decode(nonce),
            ciphertext=base64.b64decode(ciphertext),
            tag=base64.b64decode(tag),
        )

        # "bound" travels outside the AEAD, so it is attacker-mutable. Treat
        # anything other than a bound envelope as legacy and refuse it by
        # default: honouring bound=false would let a tamperer skip the
        # metadata check and rewrite sender/counter/ts at will.
        if blob.get("bound") is True or blob.get("bound") == "true":
            try:
                inner = json.loads(plain)
            except json.JSONDecodeError as e:
                raise ValueError(f"Invalid bound inner JSON: {e}") from e
            if (
                inner.get("t") != payload_type
                or inner.get("d") != sender
                or inner.get("c") != counter
                or inner.get("ts") != ts_ms
            ):
                raise ValueError("Bound metadata mismatch (possible tampering)")
            payload = inner.get("p")
            if not isinstance(payload, str):
                raise ValueError("Bound payload missing")
        elif allow_legacy_v1:
            # Legacy un-bound ciphertext (pre-interop desktop builds).
            payload = plain
        else:
            raise ValueError(
                "Rejected un-bound v2 ciphertext (metadata is not authenticated). "
                "Upgrade all devices to 3.2.0+, or set allow_legacy_v1."
            )

    # Admitted last: only a message that already authenticated under our key
    # may touch replay state. Doing this earlier lets an unauthenticated peer
    # evict real entries or pin a victim's counter to stall its traffic.
    if replay_cache is not None and not replay_cache.accept(sender, counter):
        raise ValueError("Replay or stale counter rejected")

    return payload, payload_type


def decrypt_legacy_blob(
    payload: str,
    *,
    cipher_manager,
    allow_legacy_v1: bool = False,
) -> str:
    """
    Decrypt a pre-3.2.0 bare {nonce, ciphertext, tag} blob.

    These carry no version, counter, timestamp, or metadata binding, so they
    bypass every v2 protection. They are refused under the same opt-in as v1.
    Routing every legacy decrypt through here keeps that decision in one place:
    reachable transports must not grow their own private fallback.
    """
    if not allow_legacy_v1:
        raise ValueError(
            "Rejected legacy un-versioned ciphertext (no replay or metadata "
            "binding). Upgrade all devices to 3.2.0+, or set allow_legacy_v1."
        )
    from utils.cipher_manager import CipherManager

    return cipher_manager.decrypt(**CipherManager.decode_from_json_string(payload))


def is_v2_message(body: dict) -> bool:
    return isinstance(body, dict) and body.get("v") == PROTOCOL_VERSION
