"""Generates crypto test vectors with the desktop client's own CipherManager.

Run from ClipCascade_Extension/:
    pip install pycryptodome
    python3 tests/fixtures/generate_crypto_fixtures.py
"""

import json
import os
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "ClipCascade_Desktop", "src"))

from utils.cipher_manager import CipherManager  # noqa: E402

CASES = [
    # (username, password, salt, rounds, plaintext)
    ("admin", "admin123", "", 664937, "hello from python"),
    ("alice", "pässwörd ✓", "pepper", 1000, "unicode: 日本語 🎉\nsecond line"),
    ("bob", "p", "", 1, ""),
]

fixtures = {"sha3_512": [], "cases": []}
for text in ["admin123", "", "pässwörd ✓"]:
    fixtures["sha3_512"].append(
        {"input": text, "hex": CipherManager.string_to_sha3_512_lowercase_hex(text)}
    )

for username, password, salt, rounds, plaintext in CASES:
    config = SimpleNamespace(
        data={"username": username, "salt": salt, "hash_rounds": rounds}
    )
    manager = CipherManager(config)
    key = manager.hash_password(password)
    config.data["hashed_password"] = key
    payload = CipherManager.encode_to_json_string(**manager.encrypt(plaintext))
    fixtures["cases"].append(
        {
            "username": username,
            "password": password,
            "salt": salt,
            "rounds": rounds,
            "keyHex": key.hex(),
            "plaintext": plaintext,
            "payload": payload,
        }
    )

with open(os.path.join(HERE, "crypto.json"), "w", encoding="utf-8") as f:
    json.dump(fixtures, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("wrote tests/fixtures/crypto.json")
