"""P2P device identity, signed signaling, and explicit trust/pairing."""

from __future__ import annotations

import base64
import json
import logging
import os
import time
import uuid
from typing import Any, Optional

from Crypto.Hash import SHA256
from Crypto.PublicKey import ECC
from Crypto.Signature import eddsa

TRUST_FILE_NAME = "trusted_peers.json"
SIGNING_CURVE = "Ed25519"


class DeviceIdentity:
    def __init__(self, device_id: str, private_key: ECC.EccKey, public_key: ECC.EccKey):
        self.device_id = device_id
        self.private_key = private_key
        self.public_key = public_key

    @property
    def public_pem(self) -> str:
        return self.public_key.export_key(format="PEM")

    @property
    def fingerprint(self) -> str:
        digest = SHA256.new(self.public_pem.encode("utf-8")).digest()
        return digest[:8].hex()

    def sign(self, message: bytes) -> str:
        signer = eddsa.new(self.private_key, mode="rfc8032")
        return base64.b64encode(signer.sign(message)).decode("ascii")

    def verify(self, message: bytes, signature_b64: str) -> bool:
        try:
            sig = base64.b64decode(signature_b64)
            verifier = eddsa.new(self.public_key, mode="rfc8032")
            verifier.verify(message, sig)
            return True
        except Exception:
            return False


def _canonical_bytes(obj: dict) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_or_create_identity(keyring_backend, service: str, account: str) -> DeviceIdentity:
    """Load Ed25519 identity from keyring or create a new one."""
    raw = None
    if keyring_backend is not None:
        try:
            raw = keyring_backend.get_password(service, account)
        except Exception as e:
            # A read error is not the same as "no identity yet". Minting a new
            # key here would hand every peer a new stranger on each launch, so
            # TOFU could never converge and signed signalling would quietly
            # degrade to nothing.
            raise RuntimeError(
                "Could not read the device identity from the OS keyring "
                f"({e}). Refusing to generate a replacement, which would "
                "invalidate this device's existing peer trust."
            ) from e

    if raw:
        try:
            data = json.loads(raw)
            private_key = ECC.import_key(data["private_pem"])
            public_key = ECC.import_key(data["public_pem"])
            return DeviceIdentity(data["device_id"], private_key, public_key)
        except Exception as e:
            logging.warning(f"Corrupt device identity, regenerating: {e}")

    private_key = ECC.generate(curve=SIGNING_CURVE)
    public_key = private_key.public_key()
    device_id = str(uuid.uuid4())
    identity = DeviceIdentity(device_id, private_key, public_key)
    blob = json.dumps(
        {
            "device_id": device_id,
            "private_pem": private_key.export_key(format="PEM"),
            "public_pem": public_key.export_key(format="PEM"),
        }
    )
    if keyring_backend is not None:
        try:
            keyring_backend.set_password(service, account, blob)
        except Exception as e:
            logging.warning(f"Could not persist device identity: {e}")
    return identity


def sign_signaling(identity: DeviceIdentity, message: dict) -> dict:
    """Attach deviceId, ts, and signature to a signaling message."""
    ts = int(time.time() * 1000)
    out = dict(message)
    out["deviceId"] = identity.device_id
    out["ts"] = ts
    to_sign = {k: v for k, v in out.items() if k != "sig"}
    out["sig"] = identity.sign(_canonical_bytes(to_sign))
    return out


def verify_signaling(
    message: dict, public_pem: str, max_skew_ms: int = 10 * 60 * 1000
) -> bool:
    try:
        device_id = message.get("deviceId")
        ts = message.get("ts")
        sig = message.get("sig")
        if not device_id or not isinstance(ts, int) or not sig:
            return False
        now = int(time.time() * 1000)
        if abs(now - ts) > max_skew_ms:
            return False
        to_sign = {k: v for k, v in message.items() if k != "sig"}
        public_key = ECC.import_key(public_pem)
        verifier = eddsa.new(public_key, mode="rfc8032")
        verifier.verify(_canonical_bytes(to_sign), base64.b64decode(sig))
        return True
    except Exception:
        return False


class PeerTrustStore:
    """Persists trusted peer public keys (non-secret) next to the DATA file."""

    def __init__(self, path: str):
        self.path = path
        self._peers: dict[str, dict] = {}
        self.load()

    def load(self):
        if os.path.isfile(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    self._peers = data.get("peers", {})
            except Exception as e:
                logging.warning(f"Failed to load trust store: {e}")
                self._peers = {}

    def save(self):
        try:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump({"peers": self._peers}, f, indent=2)
            try:
                os.chmod(self.path, 0o600)
            except Exception:
                pass
        except Exception as e:
            logging.warning(f"Failed to save trust store: {e}")

    def is_trusted(self, device_id: str) -> bool:
        return device_id in self._peers

    def get_public_pem(self, device_id: str) -> Optional[str]:
        peer = self._peers.get(device_id)
        return peer.get("public_pem") if peer else None

    def trust(self, device_id: str, public_pem: str, label: str = ""):
        self._peers[device_id] = {
            "public_pem": public_pem,
            "label": label,
            "trusted_at": int(time.time()),
        }
        self.save()

    def untrust(self, device_id: str):
        if device_id in self._peers:
            del self._peers[device_id]
            self.save()

    def list_peers(self) -> dict[str, dict]:
        return dict(self._peers)

    def accept_announce(
        self, device_id: str, public_pem: str, auto_trust: bool = False
    ) -> bool:
        """
        Record an announce. Returns True if peer is trusted (or auto-trusted).
        """
        if self.is_trusted(device_id):
            # Update key if it matches or replace on first-seen key rotation policy: keep existing.
            return True
        if auto_trust:
            self.trust(device_id, public_pem, label="auto")
            return True
        return False


def trust_store_path_for_data_file(data_file: str) -> str:
    directory = os.path.dirname(os.path.abspath(data_file)) or "."
    return os.path.join(directory, TRUST_FILE_NAME)
