#!/usr/bin/env python3
"""Fail if ClipCascade component versions drift from version.json."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    version_path = ROOT / "version.json"
    versions = json.loads(version_path.read_text(encoding="utf-8"))
    expected = versions.get("server")
    if not expected:
        print("version.json missing server key", file=sys.stderr)
        return 1

    errors: list[str] = []

    # All platform keys should match (normalized release).
    for key, value in versions.items():
        if value != expected:
            errors.append(f"version.json {key}={value} != server={expected}")

    checks = [
        (
            ROOT / "ClipCascade_Server/ClipCascade_Backend/src/main/java/com/acme/clipcascade/constants/ServerConstants.java",
            rf'APP_VERSION\s*=\s*"{re.escape(expected)}"',
            "ServerConstants.APP_VERSION",
        ),
        (
            ROOT / "ClipCascade_Desktop/src/pyproject.toml",
            rf'version\s*=\s*"{re.escape(expected)}"',
            "desktop pyproject version",
        ),
        (
            ROOT / "ClipCascade_Desktop/src/core/constants.py",
            rf'APP_VERSION\s*=\s*"{re.escape(expected)}"',
            "desktop APP_VERSION",
        ),
        (
            ROOT / "ClipCascade_Mobile/src/package.json",
            rf'"version"\s*:\s*"{re.escape(expected)}"',
            "mobile package.json version",
        ),
    ]

    for path, pattern, label in checks:
        text = path.read_text(encoding="utf-8")
        if not re.search(pattern, text):
            errors.append(f"{label} does not match {expected} in {path}")

    # Desktop constants uses APP_VERSION multiple times — require count >= 3
    constants = (ROOT / "ClipCascade_Desktop/src/core/constants.py").read_text(
        encoding="utf-8"
    )
    count = len(re.findall(rf'APP_VERSION\s*=\s*"{re.escape(expected)}"', constants))
    if count < 3:
        errors.append(
            f"desktop constants.py expected >=3 APP_VERSION={expected}, found {count}"
        )

    if errors:
        print("Version normalization failed:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print(f"OK: all components report version {expected}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
