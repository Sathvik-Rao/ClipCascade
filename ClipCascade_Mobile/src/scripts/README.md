# Signed Android APK upgrades

For ClipCascade, `python3 scripts/install_samsung_release.py --device "$ANDROID_SERIAL"` builds the Android **release** APK with the pre-existing ClipCascade signing certificate and upgrades the installed application in place. Set `ANDROID_SERIAL` to the intended device first. `--build-only` builds and verifies without installing; `--check-only` only verifies an existing APK. The installer refuses different signing certificates, debug builds and incorrect package names, and never uninstalls or resets app data.

The script locates its project checkout automatically. It uses an isolated Gradle user home because a machine-wide signing init script could select a different certificate. It regenerates stale React Native autolinking metadata when it still references a moved checkout. Android `MY_PACKAGE_REPLACED` restarts foreground/recovery monitoring after a data-preserving upgrade.

The backend host health timer continuously checks that the installed app is **not** debuggable, so regression to a Metro-dependent debug APK is reported instead of silently ignored.
