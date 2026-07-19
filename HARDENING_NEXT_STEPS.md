# ClipCascade hardening handoff

Branch `hardening/security-baseline`. Independent audit (2026-07-16) found over-claiming; blockers below were fixed in a follow-up patch. Remaining items are honestly **not** "fully done."

## Verified done

| Area | Status |
|------|--------|
| Baseline self-host secrets / docker / XSS / cookie | Done |
| Desktop OS keyring + migration tests | Done |
| Mobile Keystore/Keychain secrets + fail-closed logout | Done |
| Password modal + server current-password check | Done |
| Protocol v2 envelope + replay + bound metadata | Done (desktop↔mobile wire unified on bound inner JSON) |
| Desktop P2P signed signaling + trust store (TOFU) | Done (pinned PEM verify after announce) |
| READ_LOGS logcat path removed | Done |
| Share + QS tile + notification action + in-app capture button | Done |
| CSP `script-src 'self'` (no script unsafe-inline) | Done (after unlock-form fix) |
| Version 3.2.0 app surfaces + `check-versions.py` | Done |
| CI: versions, server, mobile jest, desktop tests, android assemble job, SBOM artifact, trivy | Present |

## Tailscale / private mesh (supported)

- Desktop + mobile allow HTTP to Tailscale CGNAT / `*.ts.net` / RFC1918
- Android network security config permits cleartext app-wide (it can only
  scope by domain, and a Tailscale server is normally a literal 100.x), so
  `networkPolicy.js` is the actual gate — see the partial table below
- Docs: `docs/TAILSCALE.md`, compose overlay `docker-compose.tailscale.yml`

## Still partial / not done (do not claim otherwise)

| Area | Reality |
|------|---------|
| **Desktop → iOS encrypted sync** | **Fix applied, not yet confirmed on a device.** Desktop emitted a 16-byte GCM nonce (PyCryptodome's default when none is passed); Apple's CryptoKit `AES.GCM.Nonce(data:)` accepts only 12, so every encrypted message was undecryptable on iOS. `cipher_manager.py` now emits 12 bytes, which Android and desktop also accept, and decryption stays length-agnostic so older 16-byte messages still open. Still needs a real iOS device to confirm end to end — nobody here could execute CryptoKit. |
| Desktop↔mobile interop test | **Now exists.** `ClipCascade_Desktop/src/tests/protocol_corpus.json` is one accept/reject corpus driven through both `protocol_v2.py` and `protocolV2.js`. Still no test that runs real ciphertext between the two runtimes in one process; the corpus is cipher-off. |
| Interactive P2P pairing UI | **TOFU** only — first validly self-signed `DEVICE_ANNOUNCE` is auto-trusted; no pin/dialog. Blast radius is limited by the server scoping each signaling room to one authenticated account (`P2PWebSocketHandler.java:84,266,279`), so joining needs that account's credentials — but a malicious *server* can still inject a device. The `p2p_require_pairing` config flag was **removed**: it was never read, so it implied a control that did not exist. |
| Mobile P2P **signed** signaling | **Not implemented** — mobile still sends unsigned OFFER/ANSWER/ICE; desktop rejects them. |
| Desktop↔mobile P2P mesh | Broken until mobile signs; **use P2S over Tailscale** (recommended). `server_mode` is fetched from the server, so a server can push clients into P2P where this silently cannot work. |
| Cipher-off mode | v2 metadata (sender/counter/ts) is **unauthenticated** when `cipher_enabled=false`; replay protection there is not meaningful. Documented, not fixed. |
| Android cleartext scope | `network_security_config.xml` permits cleartext at the **base config**, because Android can only scope by domain and a Tailscale server is normally a literal `100.x`. `networkPolicy.js` is the only real gate — no defence in depth below it. |
| DNS-based mesh bypass | `networkPolicy.js` checks the URL **string**, never the resolved IP, so `http://evil.localhost` (or a rebinding answer) still passes. |
| Mobile IPv6 mesh | Tailscale IPv6 (`fd7a:115c:a1e0::/48`) is rejected — the module is IPv4-only. Fails closed, but the "private mesh" claim is IPv4-only in practice. |
| True multi-GB binary streaming | Still base64 + fragment; not raw byte streams. |
| Desktop P2P stream cap | Peer-declared `wireSizeInBytes` can now only **lower** the cap, never raise it (clamped to `limit * 4`). |
| Mobile fragment DoS caps | Desktop's validator is ported: UUID id, safe-integer index/total, `MAX_RECEIVING_FRAGMENTS` 4096. |
| Password-change rate limiting | `updateOwnPassword` never touches `BruteForceProtectionService`. BCrypt strength 12 → an authenticated caller can burn CPU, and a session-hijacker can brute-force the current password unthrottled. |
| Server password strength | Cannot be enforced: all clients pre-hash, so `UserValidator` only ever sees a 128-hex string. `minlength=12` in the UI is advisory. |
| Session cookie flags | No `server.forward-headers-strategy` / `session.cookie.secure` / `same-site`. Behind a TLS-terminating proxy, JSESSIONID never gets `Secure`. |
| `/donate` open redirect | Redirects to the `funding` field fetched from GitHub. Default-off (`CC_DONATIONS_ENABLED=false`); no scheme/host allowlist. |
| Desktop update check | Calls `raw.githubusercontent.com` on every start with no opt-out (the `CC_UPDATE_CHECK_ENABLED` flag is server-side only) — a private-mesh install still phones home. |
| iOS native CI | No macOS/`xcodebuild` job. |
| Provenance attestations | Docs only; no SLSA/attest on tags. |
| `style-src 'unsafe-inline'` | Still required for legacy inline styles. |
| Username change | Still uses `prompt()`. |
| FloatingActivity class | Still in APK (unused, not launched, `exported="false"`). |
| pip-audit / Trivy | Soft-fail (`|| true` / exit-code 0). `npm audit` does gate. |
| README | Some historical ADB/READ_LOGS text may remain marked deprecated. |

## Fixed in the fourth review pass (2026-07-18)

Four independent AI reviews (Claude Opus 4.8, Cursor Grok 4.5 ×2, Composer) audited
the branch after it had been called merge-ready. Two P0s and eight P1s, several of
them self-inflicted. Every fix below has a regression test.

| Was | Now |
|-----|-----|
| **P0 — sync was broken in the default configuration.** Clients published a flat v2 envelope, but the server rebuilds relayed messages from three getters on `ClipboardData`, dropping `v`/`senderDeviceId`/`counter`/`ts`. Receivers saw no `v`, called it legacy v1, and refused it. Protocol v2 had therefore **never been in effect over P2S** — it silently degraded to v1 until strict-v1 rejection turned the no-op into an outage | Clients nest the envelope inside `payload`, which the server relays verbatim. Matches what P2P always did, and works against old unpatched servers too |
| **P0 — one P2P frame disabled protocol v2 globally (mobile).** No fragment-metadata validation, so `receivingFragments[id][index]` with `id="__proto__"` wrote `Object.prototype.allowLegacyV1`; a destructuring default fires only on `undefined`, so the inherited value won on both transports | Desktop's validator ported, fragment map is null-prototype, `allowLegacyV1` read as an own property and passed explicitly |
| `CC_TRUSTED_PROXY_CIDRS` shipped as `10.0.0.0/8,172.16.0.0/12` — the ranges where *clients* live, so any LAN client could choose its own lockout key | Single-host example, with the reason spelled out |
| Duplicate `X-Forwarded-For` lines: `getHeader()` returns the **first**, which is the client's | All values joined via `getHeaders()`, then walked right-to-left |
| `203.0.113.050`, `::::`, `1.2.3.4:5678` all passed as distinct lockout keys | Hops canonicalised through `InetAddress`; leading zeros and malformed IPv6 refused; unusable right-most hop fails closed to the socket peer |
| Trusted-proxy path had **zero** tests — all five ran with the header ignored | 12 cases covering duplicates, ports, spellings, all-trusted, junk |
| H2 password guard matched only `jdbc:h2:file:`, so `jdbc:h2:~/x` booted with an empty password (and `CIPHER=AES` with no key) | Detected by exclusion of `jdbc:h2:mem:` |
| Desktop allowed cleartext to the **public `ts.net` apex**; mobile already refused it | Suffix-only on both |
| Three sibling compose files still published `0.0.0.0:8080` while CI checked only two | All bound to `CC_BIND_ADDRESS` (loopback default); CI asserts every file |
| `cipher_enabled` with no cipher manager returned ciphertext **as plaintext** | Fails closed |
| Desktop/mobile disagreed on 4 of 34 envelopes (int-vs-float, present-null) | Shared corpus run by both suites; whole-valued floats normalised, since JSON.parse cannot distinguish `5.0` from `5` |
| RN's regex URL polyfill rejected uppercase schemes, so `HTTPS://` failed on device but passed in jest | Scheme lowercased; the URL suite now runs against **both** parsers |
| Keyring migration stripped secrets from disk whether or not they were stored — a headless box silently lost a working login | Only keys actually persisted are stripped |
| A keyring read error minted a **new device identity** each launch, so TOFU never converged | Read errors raise instead of regenerating |
| Peer-declared `wireSizeInBytes` set the cap meant to bound it | Clamped |
| Announce branch relayed an attacker-supplied `fromPeerId` when the session was unregistered | Server-assigned id required |
| CSP `connect-src ws: wss:` allowed a socket to any host | Enumerated from `CC_ALLOWED_ORIGINS` |
| Redirects were followed without re-checking the mesh policy; mobile cold-start restored a stored URL without validating it | Redirects disabled; cold start re-validates |

Tests: desktop 35 → 49, mobile 28 → 54, server 14 → 26.

## Fixed in the second review pass (2026-07-17)

Findings from an adversarial re-review, each with a regression test:

| Was | Now |
|-----|-----|
| **v1 downgrade**: deleting `"v"` skipped replay, counter, timestamp, self-origin, and binding checks entirely | v1 rejected unless `allow_legacy_v1` is set (desktop); mobile is strict-only |
| **`bound: false` bypass**: the flag sits outside the AEAD, so flipping it skipped the metadata check and let sender/counter/ts be rewritten | Un-bound ciphertext rejected under the same opt-in |
| **Replay-cache eviction**: one global 2048-entry window, so junk senders evicted a victim's history and let a captured message replay cleanly | Per-sender window, bounded sender count |
| **Pre-auth replay poisoning**: replay state was updated before the AEAD verified, so one forged message pinned a victim's counter and stalled it | Replay state is touched only after the ciphertext authenticates |
| **`<certificates src="user" />`** app-wide — no NSC existed before, so this *added* user-CA trust and made HTTPS interception easier | System CAs only |
| **Exported-activity capture proxy**: any app could `startActivity(MainActivity, ACTION_CAPTURE_CLIPBOARD)` and have ClipCascade read + transmit the clipboard, working around the Android 10+ background-read block | Internal actions require a token from private storage; the dead `capture_clipboard_now` branch removed |
| **`100.064.0.1` allowed as CGNAT**: `Number('064')` is 64 but WHATWG reads octal 52 → public IP over cleartext. Tests ran Node's parser; RN ships a regex polyfill | Leading-zero octets rejected; `ts.net` apex no longer matches |
| **`CC_ALLOWED_ORIGINS=*` accepted** → CSWSH on both WS endpoints | Startup fails with an explanation |
| **Left-most `X-Forwarded-For`** → clients behind a proxy could forge their IP and defeat brute-force limits | Right-most untrusted hop; `CC_TRUSTED_PROXY_CIDRS` documented |
| **0.0.0.0 bind** on the Tailscale overlay (Compose *appends* `ports`, so an overlay could not fix it) | Base compose owns the bind; defaults to `127.0.0.1` |
| Desktop `" http://evil.com"` and `http://[::ffff:8.8.8.8]` bypassed the public-HTTP block | Both rejected |
| `curl .../main/install.sh \| sh` in CI | Pinned `anchore/sbom-action` |
| Migrate + Tailscale compose never validated in CI | Both validated; bind address asserted |
| AES mocked as `jest.fn()` → every protocol test vacuous | Real AES-256-GCM via node crypto |

## Fixed in the third review pass (2026-07-18)

The second pass's fixes were themselves reviewed adversarially. Two of them were
bypassable:

| Was | Now |
|-----|-----|
| **The v1 rejection was bypassable on P2P.** `unwrap_inbound` only runs when the payload is a dict containing `payload`; a pre-3.2.0 peer's bare `{nonce,ciphertext,tag}` blob has no such key and fell through to a direct decrypt with no version, counter, timestamp, or binding. It never consulted `allow_legacy_v1`, so it was *more* permissive than the v1 path that had just been closed. One blob replayed five times through `P2PManager._receive` was accepted five times | All legacy decrypts route through `protocol_v2.decrypt_legacy_blob`, refused unless opted in. Mobile refuses outright. STOMP was already clean |
| **Forwarded headers still let a client choose its own address.** Right-most hop selection was right, but the resolver looped over eleven header candidates; when `X-Forwarded-For` was absent or all hops were trusted (the ordinary LAN case) it fell through to `Proxy-Client-IP`, `HTTP_VIA` and friends, which no proxy overwrites | One header only (`CC_FORWARDED_HEADER`, default `X-Forwarded-For`), falling back to the socket peer. Hops must be IP literals, so a hostname no longer reaches `InetAddress.getByName` |
| Desktop accepted counters above 2^53-1, diverging from mobile; one absurd counter pinned a sender's window and wedged that device until restart | Bounded to `Number.MAX_SAFE_INTEGER` |
| Mobile envelope validation accepted `0`, `-1`, and fractional counters | Parity with `protocol_v2.py` |
| Unused `encrypt`/`decrypt` helpers remained next to the closed path | Removed |

**Lesson recorded for the next pass:** the second pass's tests drove
`unwrap_inbound` directly and never exercised a transport's receive path, which
is exactly where the bypass lived. Test the reachable entry point, not just the
helper.

Tests: desktop 22 → 34, mobile 13 → 28, server 4 → 14.

## Prompt for next AI

```text
Do NOT claim remaining work is done. Priority:
1. Confirm the 12-byte GCM nonce on a real iOS device. The emit side is fixed
   (cipher_manager.py) but CryptoKit was never executed here, so it is reasoned
   from Apple's contract rather than observed.
2. A real desktop<->mobile interop vector test. Today each side only tests
   itself, which is how the nonce mismatch survived.
3. Mobile P2P Ed25519 (or HMAC) signed signaling matching desktop device_trust.
4. Interactive pairing UI (or document TOFU as intentional).
5. Rate-limit updateOwnPassword; add cookie Secure/SameSite + forward-headers.
6. Mobile fragment count + wire-byte caps matching desktop.
7. iOS CI if certificates available; release provenance on tags.
8. Drop style-src unsafe-inline after scrubbing inline styles.

Verify: scripts/check-versions.py, desktop unittest, mobile jest, mvnw test.
Cross-test: encrypted v2 clipboard desktop<->mobile on P2S, on real devices.
```
