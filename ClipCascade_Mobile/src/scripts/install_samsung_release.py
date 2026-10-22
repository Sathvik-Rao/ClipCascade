#!/usr/bin/env python3
"""Build and install ClipCascade on Samsung without changing signing identity.

Never uninstalls, clears app data, installs debug variants or bypasses signature
checks. Glass's global Gradle init script uses a different signing certificate:
this project must use its existing Android certificate until explicitly migrated.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
APK = ANDROID / "app/build/outputs/apk/release/app-release.apk"
GRADLE_HOME = Path.home() / ".cache/clipcascade-gradle-home"
DEVICE = "10.66.66.3:5555"
EXPECTED_SHA256 = "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c"


def execute(argv: list[str], *, cwd: Path | None = None, timeout: int = 180) -> str:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True,
                            check=False, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{argv[0]} exited {result.returncode}: {result.stderr[-700:]}")
    return result.stdout


def verify_certificate(output: str) -> None:
    if EXPECTED_SHA256 not in output.lower():
        raise RuntimeError("Refusing APK signed with different certificate; app data would be lost")


def verify_release_manifest(output: str) -> None:
    if "application-debuggable" in output:
        raise RuntimeError("Refusing debuggable APK: requires a production release")
    if "package: name='com.clipcascade'" not in output:
        raise RuntimeError("Refusing APK with incorrect Android package ID")


def aapt_path() -> Path:
    sdk = Path(os.environ.get("ANDROID_HOME", "/opt/android-sdk"))
    matches = sorted((sdk / "build-tools").glob("*/aapt"), reverse=True)
    if not matches:
        raise RuntimeError("Android aapt not found")
    return matches[0]


def verify_apk() -> None:
    if not APK.is_file():
        raise RuntimeError(f"No ClipCascade release APK at {APK}")
    verify_certificate(execute(["apksigner", "verify", "--print-certs", str(APK)], timeout=30))
    verify_release_manifest(execute([str(aapt_path()), "dump", "badging", str(APK)], timeout=30))
    print("Release APK signature and non-debug package verified")


def build() -> None:
    GRADLE_HOME.mkdir(parents=True, exist_ok=True)
    for name in ("caches", "wrapper"):
        link = GRADLE_HOME / name
        if not link.exists() and not link.is_symlink():
            link.symlink_to(Path.home() / ".gradle" / name, target_is_directory=True)
    # Cached autolinking may contain an obsolete absolute checkout path.
    generated = ANDROID / "build/generated/autolinking"
    stale_file = generated / "autolinking.json"
    if stale_file.exists():
        cached = json.loads(stale_file.read_text())
        old_root = cached.get("root") if isinstance(cached, dict) else None
        if old_root != str(ROOT):
            for candidate in generated.iterdir():
                if candidate.is_file() and (candidate.suffix == ".sha" or candidate.name == "autolinking.json"):
                    candidate.unlink()
            print("Cleared stale React Native generated autolinking paths")
    env = dict(os.environ, GRADLE_USER_HOME=str(GRADLE_HOME),
               ANDROID_HOME="/opt/android-sdk", ANDROID_SDK_ROOT="/opt/android-sdk")
    argv = ["./gradlew", "assembleRelease", "--offline", "--no-daemon", "--console=plain",
            "-PMYAPP_UPLOAD_STORE_FILE=debug.keystore",
            "-PMYAPP_UPLOAD_STORE_PASSWORD=android",
            "-PMYAPP_UPLOAD_KEY_ALIAS=androiddebugkey",
            "-PMYAPP_UPLOAD_KEY_PASSWORD=android"]
    result = subprocess.run(argv, cwd=ANDROID, env=env, text=True,
                            capture_output=True, check=False, timeout=900)
    if result.returncode:
        raise RuntimeError("Release build failed: " + result.stderr[-1000:])
    verify_apk()


def install() -> None:
    execute(["adb", "-s", DEVICE, "get-state"], timeout=15)
    result = execute(["adb", "-s", DEVICE, "install", "-r", str(APK)], timeout=180)
    if "Success" not in result:
        raise RuntimeError("Android did not confirm a successful data-preserving upgrade")
    pkg = execute(["adb", "-s", DEVICE, "shell", "dumpsys", "package", "com.clipcascade"], timeout=18)
    if "DEBUGGABLE" in pkg:
        raise RuntimeError("Installed APK is debuggable; deployment regressed")
    print("Samsung release upgraded in place; app credentials and data preserved")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true", help="Verify previously built release APK")
    parser.add_argument("--build-only", action="store_true", help="Build and verify, but do not install")
    args = parser.parse_args()
    if args.check_only:
        verify_apk()
        return
    build()
    if not args.build_only:
        install()


if __name__ == "__main__":
    main()
