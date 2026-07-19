# Self-host security checklist

ClipCascade reads clipboard data by design. Treat every connected client as a trusted device on the same clipboard bus.

## Recommended: Tailscale (or similar mesh VPN)

Prefer running the server and all clients on a **Tailscale tailnet** so you never open port 8080 to the public internet.

- Full guide: [`docs/TAILSCALE.md`](docs/TAILSCALE.md)
- Compose overlay: `ClipCascade_Server/docker-compose/docker-compose.tailscale.yml`
- Clients allow **HTTP** only for private/mesh hosts: loopback, RFC1918 LAN, Tailscale CGNAT `100.64.0.0/10`, and MagicDNS `*.ts.net`
- For public hostnames, use **HTTPS** (or Tailscale Serve)
- Set `CC_ALLOWED_ORIGINS` to every exact origin you use, e.g.  
  `http://homeserver.tail-XXXX.ts.net:8080,http://100.x.y.z:8080`  
  (comma-separated; no `*`)

## Server deployment

- Do not expose a fresh server until `CC_INITIAL_ADMIN_PASSWORD` is set.
- Set `CC_ALLOWED_ORIGINS` to the exact browser origin(s), comma-separated. The server **refuses to start** on `*`: a wildcard origin is applied verbatim to both WebSocket endpoints, so any website a user visits could open a socket with their session cookie and read their clipboard.
- Set `CC_SERVER_DB_PASSWORD` before first boot when using H2. It must be two strong values separated by one space: `<file password> <user password>`.
- Set `CC_TRUSTED_PROXY_CIDRS` **only** if the server sits behind a reverse proxy you control, as a comma-separated CIDR list of that proxy's addresses — ideally a single host, e.g. `172.18.0.2/32`.
  > **Keep the range as narrow as possible, and never let it contain clients.** Anything inside it is trusted to declare who it is forwarding for, so a *client* inside the range can name its own address and pick its own brute-force lockout key on every request. A broad range like `10.0.0.0/8` on a LAN or Docker network is the failure case: it looks like "my internal network" but it is where the clients live.

  It controls whether `X-Forwarded-For` is believed:
  - **Unset (default):** forwarded headers are ignored entirely and the socket peer is authoritative. Correct for a direct bind, including Tailscale. Clients cannot forge their IP.
  - **Set:** the right-most hop that is not itself a trusted proxy is used. Do not set it to a range that includes clients, or they regain control of their recorded IP.
  - Behind a proxy with this unset, every user collapses into the proxy's single IP, so per-IP brute-force limits stop distinguishing them.
- Use HTTPS/WSS for any non-local **public** deployment. Tailscale/LAN HTTP is acceptable on private mesh.
- Pin Docker image tags or digests. Avoid `latest` for production.
- Keep `CC_SIGNUP_ENABLED=false` unless you intentionally run a public registration server.
- Keep `CC_P2P_ENABLED=false` unless you accept STUN/ICE network metadata exposure (P2S over Tailscale is preferred).
- Keep `CC_MAX_MESSAGE_SIZE_IN_MiB` low. Large values increase memory and denial-of-service risk.

## Client privacy

- Keep client encryption enabled on every device.
- Do not use the public community server for sensitive clipboard content.
- Avoid saving passwords locally on shared machines.
- Treat incoming files as untrusted. Download into a safe folder and scan before opening.

## Client protocol

- Prefer encryption enabled on every device (`cipher_enabled`).
- Protocol v2 binds type/device/counter/timestamp by encrypting them inside the ciphertext (GCM AAD is not used, because the React Native AES-GCM binding exposes no AAD parameter), and rejects replays. Replay state is only updated after the ciphertext authenticates, so an unauthenticated peer cannot evict history or stall a device by pinning its counter.
- Pre-3.2.0 (v1 / un-bound) messages are **rejected by default**: they carry no counter, timestamp, or binding, so accepting them would let anyone who can inject into the transport strip the envelope and replay old clipboard content. Set `allow_legacy_v1` on desktop only while some device still runs < 3.2.0. Mobile is strict-only.
- With `cipher_enabled=false` there is no authentication of any kind: the payload and its metadata are attacker-modifiable and replay protection is not meaningful. Do not treat plaintext mode as protected by v2.
- P2P signaling is signed with a per-device Ed25519 key (desktop only). Trust is **TOFU**: the first validly self-signed `DEVICE_ANNOUNCE` for an unseen device ID is trusted automatically — there is no pairing prompt and no fingerprint confirmation. The server scopes each signaling room to one authenticated account, so joining a room requires that account's credentials; a malicious *server*, however, can still inject a device into the room.

## Android capture

- `READ_LOGS` and overlay (`SYSTEM_ALERT_WINDOW`) are no longer requested or used; the logcat capture path is gone.
- Use the Share sheet, Quick Settings tile, or the in-session notification/capture actions.
- Cleartext HTTP is gated in `networkPolicy.js` (loopback, RFC1918, `100.64.0.0/10`, `*.ts.net`). Android's network security config permits cleartext at the base config because it can only scope by domain, not by IP range, and a Tailscale server is normally a literal `100.x` address — so the JS check is the real gate, not a second layer. Do not point release clients at public HTTP servers.
- Only system CAs are trusted. Do not add `<certificates src="user" />` to the base config: it would apply to every domain, letting any user- or MDM-installed CA intercept HTTPS to a public server.

## Known network egress

- Server admin update checks call GitHub unless `CC_UPDATE_CHECK_ENABLED=false`.
- Donation metadata is fetched only when donations are enabled.
- P2P mode uses the configured STUN server.

## Signing / provenance

See `docs/SIGNING.md` for release signing, SBOM, and digest pinning guidance.
