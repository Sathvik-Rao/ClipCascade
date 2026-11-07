# ClipCascade headless deployment

The **tracked** `clipcascade-headless` executable is the authoritative daemon source. A local symlink may point to it, while systemd's user service invokes the ClipCascade Python venv directly. Do not resurrect an old locally copied script after a repair. Configure `CLIPCASCADE_USERNAME` and `CLIPCASCADE_SERVER_URL` in the service environment, or retain those values in the existing private ClipCascade configuration file.

It reauthenticates on WebSocket loss, tears down and reconstructs P2P after a missing RTC data channel for 12 seconds, and also reconstructs it if an open data channel has failed to answer an application-level challenge for over 110 seconds. A healthy WebSocket is **not** sufficient. Do not repeatedly restart an otherwise healthy daemon just because a phone is locked or Wi-Fi changes.

Each second it atomically writes `$XDG_RUNTIME_DIR/clipcascade-health.json` (mode 0600). This contains only counters: timestamp, process ID, signaling status, remote peer count, open RTC channels, recently verified round trips and last proof age. It never includes clipboard contents, passwords or encryption keys. backend host's `clipcascade-health-guard.timer` checks this from outside desktop host and alerts via Matrix when the complete chain fails.

Runtime log: `~/.local/state/clipcascade/clipcascade.log`. Source WebRTC implementation: `ClipCascade_Desktop/src/p2p/p2p_manager.py`. Validate with the Python venv's `py_compile` and the real backend host/Android handset application-level challenge/response after any deployment. Keep existing data, logs and keys intact.
