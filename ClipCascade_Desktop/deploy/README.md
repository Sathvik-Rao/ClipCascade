# Glass ClipCascade headless deployment

The **tracked** `clipcascade-headless` executable is the authoritative version of Glass's persistent clipboard daemon. `/home/brandon/.local/bin/clipcascade-headless` is a symlink to this file; systemd's user service runs it with the ClipCascade Python venv. Do not resurrect an old locally copied script after a repair.

It reauthenticates on WebSocket loss, tears down and reconstructs P2P after a missing RTC data channel for 12 seconds, and also reconstructs it if an open data channel has failed to answer an application-level challenge for over 110 seconds. A healthy WebSocket is **not** sufficient. Do not repeatedly restart an otherwise healthy daemon just because a phone is locked or Wi-Fi changes.

Each second it atomically writes `/run/user/1000/clipcascade-health.json` (mode 0600). This contains only counters: timestamp, process ID, signaling status, remote peer count, open RTC channels, recently verified round trips and last proof age. It never includes clipboard contents, passwords or encryption keys. Nox's `clipcascade-health-guard.timer` checks this from outside Glass and alerts via Matrix when the complete chain fails.

Runtime log: `/home/brandon/.local/state/clipcascade/clipcascade.log`. Source WebRTC implementation: `ClipCascade_Desktop/src/p2p/p2p_manager.py`. Validate with the Python venv's `py_compile` and the real Nox/Samsung application-level challenge/response after any deployment. Keep existing data, logs and keys intact.
