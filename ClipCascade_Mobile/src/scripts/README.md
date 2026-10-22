# Signed Samsung APK upgrades

For ClipCascade, `python3 scripts/install_samsung_release.py` builds the Android **release** APK with the pre-existing ClipCascade signing certificate and upgrades the installed application in place. `--build-only` builds and verifies without installing; `--check-only` only verifies an existing APK. The installer refuses different signing certificates, debug builds and incorrect package names, and never uninstalls or resets app data.

The repository must remain under `/home/brandon/clip-cascade` on Glass. The script uses an isolated Gradle user home because Glass's generic Google Play signing init script uses a different certificate from the one already installed for this app. The script regenerates stale React Native autolinking metadata when it still references a moved checkout. Android `MY_PACKAGE_REPLACED` restarts foreground/recovery monitoring after a data-preserving upgrade.

The Nox health timer continuously checks that the installed app is **not** debuggable, so regression to a Metro-dependent debug APK is reported instead of silently ignored.
