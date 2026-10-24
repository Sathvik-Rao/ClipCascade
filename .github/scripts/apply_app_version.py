"""
Inject versions into APP_VERSION constants across the code.

Builds may supply VERSIONS_JSON to use unpublished release versions without
modifying version.json. Otherwise read version.json as before.

Targets:
  - ClipCascade_Desktop/src/core/constants.py (windows, macos, linux_gui, linux_non_gui)
  - ClipCascade_Mobile/src/AppVersion.js         (android)
  - ClipCascade_Mobile/src/android/app/build.gradle (android versionName + versionCode)
  - ClipCascade_Server/ClipCascade_Backend/src/main/java/com/acme/clipcascade/constants/ServerConstants.java (server)

Run unconditionally — it's idempotent and just rewrites APP_VERSION lines to
match version.json. Safe to run even when no bumps happened.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VERSIONS = json.loads(
    os.environ.get("VERSIONS_JSON")
    or (REPO_ROOT / "version.json").read_text(encoding="utf-8")
)


def replace_in_file(path: Path, pattern: str, repl: str, *, required: bool = True) -> int:
    if not path.exists():
        if required:
            sys.exit(f"missing file: {path}")
        return 0
    text = path.read_text(encoding="utf-8")
    new_text, n = re.subn(pattern, repl, text)
    if n == 0 and required:
        sys.exit(f"pattern not found in {path}: {pattern}")
    if n:
        path.write_text(new_text, encoding="utf-8")
    return n


def patch_constants_py() -> None:
    path = REPO_ROOT / "ClipCascade_Desktop" / "src" / "core" / "constants.py"
    text = path.read_text(encoding="utf-8")

    text = re.sub(
        r'(if PLATFORM == WINDOWS:\s*\n\s*APP_VERSION\s*=\s*")[^"]+(")',
        rf'\g<1>{VERSIONS["windows"]}\g<2>',
        text,
        count=1,
    )
    text = re.sub(
        r'(elif PLATFORM == MACOS:\s*\n\s*APP_VERSION\s*=\s*")[^"]+(")',
        rf'\g<1>{VERSIONS["macos"]}\g<2>',
        text,
        count=1,
    )
    text = re.sub(
        r'(if XMODE:\s*\n\s*APP_VERSION\s*=\s*")[^"]+(")',
        rf'\g<1>{VERSIONS["linux_gui"]}\g<2>',
        text,
        count=1,
    )
    text = re.sub(
        r'(else:\s*\n\s*APP_VERSION\s*=\s*")[^"]+(")',
        rf'\g<1>{VERSIONS["linux_non_gui"]}\g<2>',
        text,
        count=1,
    )
    path.write_text(text, encoding="utf-8")
    print(f"patched {path}")


def patch_app_js() -> None:
    path = REPO_ROOT / "ClipCascade_Mobile" / "src" / "AppVersion.js"
    replace_in_file(
        path,
        r"const APP_VERSION = '[^']+';",
        f"const APP_VERSION = '{VERSIONS['android']}';",
    )
    print(f"patched {path}")


def semver_to_version_code(v: str) -> int:
    a, b, c = (int(p) for p in v.split("."))
    return a * 10000 + b * 100 + c


def patch_android_gradle() -> None:
    path = REPO_ROOT / "ClipCascade_Mobile" / "src" / "android" / "app" / "build.gradle"
    code = semver_to_version_code(VERSIONS["android"])
    replace_in_file(
        path,
        r"versionCode\s+\d+",
        f"versionCode {code}",
    )
    replace_in_file(
        path,
        r'versionName\s+"[^"]+"',
        f'versionName "{VERSIONS["android"]}"',
    )
    print(f"patched {path}")


def patch_server_constants() -> None:
    path = (
        REPO_ROOT
        / "ClipCascade_Server"
        / "ClipCascade_Backend"
        / "src"
        / "main"
        / "java"
        / "com"
        / "acme"
        / "clipcascade"
        / "constants"
        / "ServerConstants.java"
    )
    replace_in_file(
        path,
        r'public static final String APP_VERSION\s*=\s*"[^"]+";',
        f'public static final String APP_VERSION = "{VERSIONS["server"]}";',
    )
    print(f"patched {path}")


def patch_docker_compose() -> None:
    path = REPO_ROOT / "ClipCascade_Server" / "docker-compose" / "docker-compose.yml"
    replace_in_file(
        path,
        r"image:\s*sathvikrao/clipcascade:\d+\.\d+\.\d+",
        f"image: sathvikrao/clipcascade:{VERSIONS['server']}",
    )
    print(f"patched {path}")


def main() -> None:
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    if only in ("all", "desktop"):
        patch_constants_py()
    if only in ("all", "android"):
        patch_app_js()
        patch_android_gradle()
    if only in ("all", "server"):
        patch_server_constants()
        patch_docker_compose()


if __name__ == "__main__":
    main()
