"""
Advance the global release version and assign it to selected platforms.

Reads:
    BUMPS_JSON env var  -> {"key": "major|minor|patch", ...}
    version.json at repo root

Writes:
    version.json updated in place
    GITHUB_OUTPUT lines:
        old_versions=<json>
        new_versions=<json>
        bumped_keys=<json list>
        release_version=<x.y.z>
        tag=v<release_version>
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION_FILE = REPO_ROOT / "version.json"
PLATFORM_KEYS = {"windows", "macos", "linux_gui", "linux_non_gui", "android", "server"}
BUMP_PRIORITY = {"patch": 0, "minor": 1, "major": 2}


def bump(current: str, level: str) -> str:
    parts = current.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        sys.exit(f"version '{current}' is not x.y.z")
    major, minor, patch = (int(p) for p in parts)
    if level == "major":
        major, minor, patch = major + 1, 0, 0
    elif level == "minor":
        minor, patch = minor + 1, 0
    elif level == "patch":
        patch += 1
    else:
        sys.exit(f"unknown bump level: {level}")
    return f"{major}.{minor}.{patch}"


def max_semver(versions: list[str]) -> str:
    def key(v: str) -> tuple[int, int, int]:
        a, b, c = (int(p) for p in v.split("."))
        return a, b, c

    return sorted(versions, key=key)[-1]


def advance_versions(versions: dict[str, str], bumps: dict[str, str]) -> dict[str, str]:
    if not bumps:
        sys.exit("no platforms selected for release")
    for key, level in bumps.items():
        if key not in PLATFORM_KEYS or key not in versions:
            sys.exit(f"unknown or missing platform '{key}'")
        if level not in BUMP_PRIORITY:
            sys.exit(f"unknown bump level: {level}")

    if "release" not in versions:
        sys.exit("version.json must contain a global 'release' version")
    # Validate the baseline before changing anything; it must cover all platforms.
    for value in versions.values():
        bump(value, "patch")
    if max_semver(list(versions.values())) != versions["release"]:
        sys.exit("global release version must not be below a platform version")

    level = max(bumps.values(), key=BUMP_PRIORITY.__getitem__)
    release = bump(versions["release"], level)
    updated = dict(versions)
    updated["release"] = release
    for key in bumps:
        updated[key] = release
    return updated


def emit_output(key: str, value: str) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    if not out:
        print(f"{key}={value}")
        return
    with open(out, "a", encoding="utf-8") as f:
        f.write(f"{key}={value}\n")


def main() -> None:
    bumps_raw = os.environ.get("BUMPS_JSON", "").strip()
    if not bumps_raw:
        sys.exit("BUMPS_JSON env var is empty")
    bumps: dict[str, str] = json.loads(bumps_raw)

    versions = json.loads(VERSION_FILE.read_text(encoding="utf-8"))
    old = dict(versions)

    versions = advance_versions(versions, bumps)

    VERSION_FILE.write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")

    emit_output("old_versions", json.dumps(old))
    emit_output("new_versions", json.dumps(versions))
    emit_output("bumped_keys", json.dumps(sorted(bumps.keys())))
    emit_output("release_version", versions["release"])
    emit_output("tag", f"v{versions['release']}")

    print(f"Bumped: {bumps}")
    print(f"New version.json: {json.dumps(versions, indent=2)}")


if __name__ == "__main__":
    main()
