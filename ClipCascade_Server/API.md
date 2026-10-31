# ClipCascade server API and alternative-client implementation guide

This reference describes the HTTP endpoints and WebSocket protocols implemented by
the ClipCascade server in this repository. Paths are relative to your server URL
(for example, `http://localhost:8080`). Use HTTPS/WSS when accessing a remote server.
There is no `/api` prefix.

This document describes the **checked-in implementation**, including the desktop
and mobile payload conventions required to communicate with existing clients.
The server version constant in this tree is `3.1.0`; deployed builds may differ.
There is no separately versioned API, capability-negotiation endpoint, or generated
OpenAPI contract. Probe the running server instead of assuming its mode or limits.

## Contents

- [Client implementation roadmap](#client-implementation-roadmap)
- [Authentication and CSRF](#authentication-and-csrf)
- [Response conventions](#response-conventions)
- [Public HTTP endpoints](#public-http-endpoints)
- [Authenticated HTTP endpoints](#authenticated-http-endpoints)
- [Admin HTTP endpoints](#admin-http-endpoints)
- [Clipboard WebSocket protocols](#clipboard-websocket-protocols)
- [Clipboard payload encoding and encryption](#clipboard-payload-encoding-and-encryption)
- [Size limits and deployment configuration](#size-limits-and-deployment-configuration)
- [Recovery and troubleshooting](#recovery-and-troubleshooting)
- [Interoperability acceptance checklist](#interoperability-acceptance-checklist)
- [Implementation sources](#implementation-sources)

## Client implementation roadmap

1. Collect the server base URL, exact username, and original password. To work
   with official clients, also collect matching encryption settings: enabled
   (default `true`), PBKDF2 iterations (default `664937`), and extra salt (default
   empty string). The server does not supply these encryption settings.
2. Obtain a pre-login CSRF token and cookie, submit the password digest, retain
   the post-login cookies, and confirm identity with `/whoami`.
3. Fetch `/csrf-token`, `/server-mode`, `/server-version`, and `/max-size`.
   In P2P mode, also fetch `/stun-url`.
4. Establish the selected authenticated WebSocket transport. P2S uses STOMP;
   P2P uses JSON signaling followed by WebRTC data channels.
5. Serialize text/images/files, optionally encrypt the resulting string, and
   wrap it in the clipboard envelope. Fragment only for P2P data channels.
6. Receive, reassemble where needed, decrypt, decode, and apply the clipboard
   update. Suppress local clipboard events caused by received updates and suppress
   your own P2S echo.
7. Handle disconnects, expired sessions, peer changes, and explicit logout.
   Reconnect transports and subscriptions; there is no offline replay.

| Property | P2S | P2P |
| --- | --- | --- |
| Default server mode | Yes | Opt-in |
| Socket endpoint | `/clipsocket` | `/p2psignaling` |
| Socket application protocol | STOMP | JSON signaling |
| Clipboard transport | Server relays STOMP messages | WebRTC `cliptext` data channels |
| Recipient selection | All subscribed sessions of the authenticated username | Client sends to each connected peer of that username |
| Sender receives own update | Yes, when subscribed | Client does not create a connection to itself |
| Server sees clipboard envelope | Yes; payload may be encrypted | No; sees signaling |
| Clipboard persistence / history / replay | None | None |

A device is a connection, not a registered resource. There are no device tokens,
HTTP clipboard upload/download routes, room-management routes, delivery-status
routes, or password-reset/email-verification flows in this API. The `email` and
`otp` admin record fields do not imply such flows exist.

## Authentication and CSRF

The server uses Spring Security form login and session cookies. It does not
provide API keys, bearer tokens, or HTTP Basic authentication. Preserve cookies
across requests, including the session cookie returned after login; the cookie
name is normally `JSESSIONID`. The optional JDBC session store explicitly uses
`JSESSIONID` too. Treat the cookie value as opaque and honor its path/domain and
Secure attributes; never decode or invent it.

1. `GET /login` and retain the cookies. Read the hidden `_csrf` input from the HTML.
2. `POST /login` with form fields `username`, `password`, and `_csrf`, using the
   same cookies. The password must be the **lowercase hexadecimal SHA3-512 digest
   of the UTF-8 password**, matching the official clients. Do not use Keccak-512.
3. Successful login redirects to `/`; failed login redirects to `/login?error`.
   A redirect or an HTML response alone does not prove authentication succeeded.
4. Verify the session with `GET /whoami`. Fetch `GET /csrf-token` after login to
   obtain the current token for subsequent mutations.

A reused anonymous session need not return a fresh `Set-Cookie` on `GET /login`.
Use a cookie jar throughout; do not copy a complete `Set-Cookie` value (including
its attributes) into a request's `Cookie` header. `/validate-session` returning
exactly `OK` is also an authentication check. A failed form login can return
HTTP 200 after following its redirect, so the final HTTP status alone is insufficient.

For deployments, see the [reverse-proxy setups and connection checker](reverse-proxy/README.md).
Preserve the public HTTPS origin and port in forwarding headers. Native clients
must reach the whole application without an external interactive SSO challenge,
including authenticated metadata routes and the `/` login-success redirect.

`POST`, `PUT`, and `DELETE` requests require a CSRF token, including login,
signup, and logout. For authenticated JSON requests, send the token in the header
named by `headerName` in `/csrf-token` (normally `X-CSRF-TOKEN`). Form requests can
send it using `parameterName` (normally `_csrf`). Fetch a new token after signing
in again. `/csrf-token` itself requires authentication; use the login/signup HTML
to obtain an initial token.

Example using Python with the `requests` package installed:

```python
import getpass
import hashlib
from html.parser import HTMLParser

import requests


class CsrfParser(HTMLParser):
    token = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "input" and attrs.get("name") == "_csrf":
            self.token = attrs.get("value")


base = "http://localhost:8080"
session = requests.Session()
login_page = session.get(base + "/login", timeout=15)
login_page.raise_for_status()
parser = CsrfParser()
parser.feed(login_page.text)
if not parser.token:
    raise RuntimeError("Login page did not provide a CSRF token")

username = input("Username: ")
raw_password = getpass.getpass("Password: ")
password = hashlib.sha3_512(raw_password.encode("utf-8")).hexdigest()
response = session.post(
    base + "/login",
    data={"username": username, "password": password, "_csrf": parser.token},
    allow_redirects=False,
    timeout=15,
)
from urllib.parse import urlsplit

if response.status_code != 302 or urlsplit(response.headers.get("Location", "")).path != "/":
    raise RuntimeError("Login failed: " + str(response.status_code))

identity = session.get(base + "/whoami", allow_redirects=False, timeout=15)
identity.raise_for_status()
print(identity.json())  # {"username": "...", "role": "USER"} or role "ADMIN"

response = session.get(base + "/csrf-token", timeout=15)
response.raise_for_status()
csrf = response.json()
session.headers[csrf["headerName"]] = csrf["token"]

# Reuse session for authenticated requests, including JSON mutations:
# session.put(base + "/update-password", json={"newPassword": new_digest}, timeout=15)
```

Password fields in signup, registration, and password updates use the same
SHA3-512 digest convention. The server applies BCrypt to the submitted value for
storage. Usernames must be nonblank and cannot start or end with spaces. Roles
are uppercase `USER` and `ADMIN`; admin registration permits only `USER`.

### Credential and session lifecycle

The digest is 128 lowercase hexadecimal characters. SHA3-512 and the clipboard
PBKDF2 key are separate derivations: **keep the original password for encryption**.
The server BCrypt-hashes the submitted credential; its validator only checks
that a password is nonempty, not that it has the correct digest shape. Submitting
plaintext during registration can therefore create an account incompatible with
the official login convention. The login digest is itself a reusable credential;
protect it and the session cookie as you would a password.

Usernames are used as supplied for login and key derivation; do not silently
lowercase or normalize them. Registration checks existing names case-insensitively,
while authentication looks up the supplied ID. Use the exact stored spelling.
There is no application-level maximum-length contract beyond database/framework
constraints. Username and password changes require deriving a new clipboard key
on every client because both inputs participate in key derivation.

- Multiple concurrent login sessions are allowed (no configured maximum).
- `POST /logout` ends the current HTTP session. Explicitly close your socket and
  P2P peer connections as part of logout; this route does not call the application's
  all-session WebSocket revocation service.
- `DELETE /logout-session` revokes every session for the current username, not
  merely the calling device. Admin per-user/global logout does the analogous
  operation. Account password/status/name changes and deletion also revoke the
  affected user's sessions and close tracked local sockets with code `1008`,
  reason `Session revoked`.
- Revoking signaling does not itself terminate an already-established direct
  WebRTC channel. A client must close its data channels and peer connections when
  its session is revoked or it logs out.
- Default HTTP inactivity timeout is `525960m`, configurable by the operator.
  Do not assume a live socket refreshes HTTP session activity. Check
  `/validate-session` when resuming or troubleshooting a connection.
- With session persistence disabled (default), a server restart loses in-memory
  sessions. JDBC persistence can retain unexpired sessions across restart; sockets
  always need reconnecting. Disabling persistence clears its stored sessions.

### Signup sequence

Fetch `/signup` for the CSRF token, then `/captcha` using the same cookie jar.
Display the PNG to the user and submit the answer with the username, password
**digest**, and CSRF token as URL-encoded form data. The captcha is 200 × 50 pixels
with 5–6 alphanumeric characters, compared case-insensitively. Fetching another
captcha replaces the previous answer. Validation consumes the answer even on a
failed attempt, so fetch a fresh captcha before retrying signup. Registration
success is plain text and does not create an authenticated session: log in next.
Duplicate usernames, invalid fields, and the operator's account-count limit can
all cause registration failure. There is no public signup-enabled JSON endpoint.

### Browser clients and origins

A same-origin browser client can use its cookie jar automatically for WebSockets
and same-origin `fetch`. JavaScript cannot set a `Cookie` header on a browser
WebSocket. Native clients must copy the applicable authenticated cookies into the
HTTP upgrade request. Do not put credentials in a WebSocket URL or STOMP body.

`CC_ALLOWED_ORIGINS` controls WebSocket origin checks; it does not enable
cross-origin HTTP CORS. This source has no general HTTP CORS configuration. A
separately hosted browser client therefore needs deployment support for its HTTP
requests and cookies, or a same-origin reverse proxy. Persistent-session cookies
use HttpOnly and SameSite=Lax; Secure follows whether the request is secure.
Configure TLS/proxy forwarding consistently and retain certificate verification.
Routes below are application-root paths; a proxy path prefix requires appropriate
rewrites, including redirects (login success explicitly redirects to `/`).

## Response conventions

Successful data requests return JSON objects/arrays or plain text, as listed
below. Successful mutations generally return `200` with a plain-text message,
such as `Password updated successfully`; there is no common JSON response wrapper.

Validation failures and exceptions handled by `ResponseEntityUtil` return `400`
with plain-text error messages. Most admin role checks also return `400 Forbidden`.
The two admin session logout endpoints explicitly return `403 Forbidden` for a
non-admin. Missing/invalid CSRF tokens produce `403` through Spring Security.
Unauthenticated requests generally redirect to `/login`; expired sessions can
redirect to `/login?expired`. Clients should inspect redirects and content types
before parsing JSON. Malformed request bodies or unhandled exceptions may produce
Spring's error responses rather than these plain-text messages.

## Public HTTP endpoints

These routes do not require authentication. Public mutations still require CSRF.

| Method | Path | Input / response |
| --- | --- | --- |
| GET | `/health` | Plain text `OK`. |
| GET | `/ping` | Plain text `pong`. |
| GET | `/login` | Login HTML with a CSRF form token. |
| POST | `/login` | Form fields `username`, `password`, `_csrf`; redirects as described above. |
| GET | `/signup` | Signup HTML if enabled; otherwise redirects to `/`. |
| POST | `/signup` | Form fields `username`, `password`, `captchaInput`, `_csrf`. Returns `User registered successfully` or `400` (for example, `Captcha validation failed` or `Signup is disabled`). Does not log the user in. |
| GET | `/captcha` | PNG captcha when signup is enabled; keep its session cookies for signup. Returns an empty body when signup is disabled. |
| GET | `/logout` | Logout confirmation HTML; does not itself perform logout. |
| POST | `/logout` | CSRF-protected session logout; redirects to `/login?logout`. |
| GET | `/help` | Redirects to the configured project help URL. |
| GET | `/donate` | Redirects to the donation URL when enabled, otherwise `/`. |

Static assets under `/assets/**` are public. `GET /` serves the authenticated
home UI (static `index.html`); it requires a session.

## Authenticated HTTP endpoints

All routes here require a logged-in user, including the configuration endpoints.

| Method | Path | Input / response |
| --- | --- | --- |
| GET | `/whoami` | `{"username":"alice","role":"USER"}`. |
| GET | `/validate-session` | Plain text `OK`. |
| GET | `/csrf-token` | JSON containing `token`, `headerName`, and `parameterName`. |
| GET | `/server-mode` | `{"mode":"P2P"}` or `{"mode":"P2S"}`. |
| GET | `/stun-url` | `{"url":"..."}`; empty string in P2S mode. |
| GET | `/max-size` | `{"maxsize":1048576}`; configured message size in bytes (example value). |
| GET | `/max-message-size` | `{"maxmessagesize":1.0}`; configured message size in MiB (example value). |
| GET | `/donation-status` | `{"enabled":true}` or `{"enabled":false}`. |
| GET | `/server-version` | `{"version":"..."}` for the running server. |
| GET | `/latest-server-version` | JSON fetched from the project's version URL; fields follow that upstream document. Can return `400` if fetching/parsing fails. |
| PUT | `/update-password` | JSON `{"newPassword":"<SHA3-512 digest>"}`. Updates the current user's password and expires their sessions. |
| DELETE | `/logout-session` | No body. Logs the current user out of all active sessions; returns a plain-text status. |

## Admin HTTP endpoints

All `/admin/*` routes below require an authenticated `ADMIN`. Mutations use
`Content-Type: application/json` when a JSON body is listed, plus a CSRF header.

| Method | Path | Input / response |
| --- | --- | --- |
| GET | `/admin/advance` | HTML showing server configuration; a non-admin is redirected to `/`. |
| GET | `/admin/server-version` | Same response as `/server-version`. |
| GET | `/admin/latest-server-version` | Same response as `/latest-server-version`. |
| GET | `/admin/server-time` | Plain text `Epoch time: <seconds>`. |
| GET | `/admin/websocket-stats` | Plain-text statistics for the active WebSocket mode. |
| GET | `/admin/online-users` | JSON map of usernames to live connection counts, e.g. `{"alice":2}`. |
| GET | `/admin/all-users` | JSON array of user records, including the admin. |
| GET | `/admin/users` | JSON array of `USER` records. |
| GET | `/admin/user-details` | JSON array of `UserInfo` records. |
| GET | `/admin/bfa-snapshot` | JSON brute-force tracker map keyed by username; each value contains `ipAccessDetails`, `uniqueIpSet`, and `lockTimeout`. |
| GET | `/admin/bfa-snapshot-file` | Serialized tracker JSON as a byte response. A non-admin receives an empty body. |
| GET | `/admin/users/page` | Paginated user records; parameters below. |
| GET | `/admin/user-details/page` | Paginated user details, with an additional `enabled` field. |
| GET | `/admin/online-users/page` | Paginated records with `username` and `connections`. |
| GET | `/admin/bfa-snapshot/page` | Paginated tracker rows, one per username/source IP. |
| POST | `/admin/register-user` | JSON `{"username":"alice","password":"<SHA3-512 digest>","role":"USER","enabled":true}`. `enabled` defaults to `true` if omitted. |
| PUT | `/admin/toggle-user-status` | JSON `{"username":"alice","enabled":"false"}` (string value). Expires the target user's sessions. |
| PUT | `/admin/update-user-password` | JSON `{"username":"alice","newPassword":"<SHA3-512 digest>"}`. Expires the target user's sessions. |
| PUT | `/admin/update-username` | JSON `{"oldUsername":"alice","newUsername":"alice2"}`. Expires sessions for the old username. |
| PUT | `/admin/unlock-user` | JSON `{"username":"alice"}`; removes the user's brute-force tracker entry. |
| DELETE | `/admin/delete-user` | JSON `{"username":"alice"}`. Expires sessions; the admin cannot be deleted. |
| DELETE | `/admin/logout-user-session` | JSON `{"username":"alice"}`. Logs out all sessions for that user. |
| DELETE | `/admin/logout-all-sessions` | No body. Logs out every user's sessions, including the admin's. |

User records contain `username`, `password` (returned as `null`), `role`, and
`enabled`. `UserInfo` fields are `username`, `markedForDeletion`, `firstSignup`,
`lastLogin`, `firstSignupIp`, `lastLoginIp`, `failedLoginAttempts`, `lockoutTime`,
`passwordChangedAt`, `email`, `otp`, `phone`, `firstName`, `lastName`, and `notes`.
Fields may be null. Paginated brute-force rows contain `username`, `sourceIp`,
`attempts`, `lockCount`, `lockTimeout`, `uniqueIpCount`, and `userLockTimeout`.

### Admin record schemas and operation results

`/admin/users` and `/admin/users/page` include only `USER` accounts;
`/admin/all-users` also includes the admin. User-info listings can contain records
marked for deletion whose user account no longer exists. There is one admin
account enforced at server startup; registration cannot create a second admin.

Example user record (the `password` field is deliberately cleared in listings):

```json
{"username":"alice","password":null,"role":"USER","enabled":true}
```

| User-info field | JSON type / interpretation |
| --- | --- |
| `username` | String account identifier |
| `markedForDeletion` | Boolean; retained record scheduled for startup purge |
| `firstSignup`, `lastLogin`, `passwordChangedAt` | Integer Unix epoch **seconds**, or null |
| `firstSignupIp`, `lastLoginIp` | String, or null |
| `failedLoginAttempts` | Integer login-history value; not the live brute-force tracker |
| `lockoutTime` | Human-readable duration string, or null; not an expiry timestamp |
| `email`, `otp`, `phone`, `firstName`, `lastName`, `notes` | String, or null; no public edit endpoints for these fields |
| `enabled` | Only in paginated user-details: boolean or null if no matching account |

Paginated user-details are **flat** objects, not `{info: {...}, enabled: ...}`.
The live brute-force snapshot is a map; its nested shape is:

```json
{
  "alice":{
    "ipAccessDetails":{
      "192.0.2.10":{"attempts":2,"lockCount":0,"lockTimeout":0}
    },
    "uniqueIpSet":["192.0.2.10"],
    "lockTimeout":0
  }
}
```

Here both `lockTimeout` fields are integer Unix epoch **seconds**; zero is the
reset epoch, not an indefinite lock. The outer timeout is user-wide; the nested
one is per source IP. `uniqueIpSet` serializes as an unordered array.
The paginated form flattens each username/IP into a row:

```json
{"username":"alice","sourceIp":"192.0.2.10","attempts":2,"lockCount":0,"lockTimeout":0,"uniqueIpCount":1,"userLockTimeout":0}
```

`/admin/bfa-snapshot-file` contains serialized JSON bytes of the tracker; it does
not promise a download filename or a JSON content type. `/admin/websocket-stats`
is human-readable, mode-dependent text, not a stable machine-readable schema.
Online-user counts describe live transport connections, not registered devices
or open P2P data channels. In P2P, a user with two signaling connections can still
have zero successfully negotiated data channels.

Successful mutations return `200` with the following plain-text bodies:

| Route | Success body |
| --- | --- |
| `/signup`, `/admin/register-user` | `User registered successfully` |
| `/update-password`, `/admin/update-user-password` | `Password updated successfully` |
| `/admin/update-username` | `Username updated successfully` |
| `/admin/toggle-user-status` | `User enabled successfully` or `User disabled successfully` |
| `/admin/delete-user` | `User deleted successfully` |
| `/admin/unlock-user` | `User unlocked successfully` |
| `/admin/logout-all-sessions` | `All users have been logged out of all active sessions.` |
| `/logout-session`, `/admin/logout-user-session` | `User 'alice' has been logged out of all active sessions.` or `No active sessions found for username: alice` |

These endpoints do not return the changed user record. Fetch the appropriate
listing after a change if the calling session remains valid. Representative
application failures are `400` with `Invalid user or password`, `Invalid user or
username`, `Invalid user or operation failed`, `User already exists or invalid
user`, `Role must be user`, `admin user cannot be deleted`, `Invalid username`,
or `User not found`. Exact error selection depends on the operation and validation
path; do not use string matching as a substitute for status handling.

The status-update endpoint parses its string `enabled` with
`Boolean.parseBoolean`: only case-insensitive `"true"` enables; other/missing values
become false. Always send an explicit `"true"` or `"false"`. Registration's `enabled`
is a JSON boolean instead. Password updates do not require an `oldPassword` field.
Rename can also rename the admin and invalidates its sessions if it is the target.
Deleting or renaming marks old user-info records for deletion, which can prevent
immediate reuse of the old name until startup cleanup. There is no user-facing
self-delete route.

Example authenticated mutation, using the `session` initialized above:

```python
# Administrative example; execute only when you intend to create this account.
# new_digest = hashlib.sha3_512(new_password.encode("utf-8")).hexdigest()
# result = session.post(base + "/admin/register-user", json={
#     "username": "alice", "password": new_digest,
#     "role": "USER", "enabled": True,
# }, allow_redirects=False, timeout=15)
# print(result.status_code, result.text)
```

### Pagination, sorting, and search

The four `/page` endpoints accept `page` (zero-based, default `0`), `size` (default
`10`), `sort`, `direction`, and `search`. Search trims whitespace and matches
case-insensitive substrings. `direction=desc` is case-insensitive; any other
nonempty direction is ascending. Unknown sort keys leave rows unsorted.

| Endpoint | Default sort / direction | Supported sort keys | Search fields |
| --- | --- | --- | --- |
| `/admin/users/page` | `username` / `asc` | `username`, `enabled` | Username |
| `/admin/user-details/page` | `lastLogin` / `desc` | All `UserInfo` fields above, plus `enabled` | Username, email, first/last name, phone, signup/login IP, notes |
| `/admin/online-users/page` | `connections` / `desc` | `username`, `connections` | Username |
| `/admin/bfa-snapshot/page` | `username` / `asc` | All brute-force row fields above | Username, source IP |

`size <= 0` returns all matching rows on page `0`. Page numbers outside the valid
range are clamped. Even an empty result reports at least one page. Response example:

```json
{
  "content": [{"username":"alice","connections":2}],
  "totalElements": 1,
  "totalPages": 1,
  "page": 0,
  "size": 10,
  "sort": "connections",
  "direction": "desc",
  "search": null
}
```

## Clipboard WebSocket protocols

First log in over HTTP, then send the authenticated session cookie with the
WebSocket upgrade request. Convert `http` → `ws` or `https` → `wss` and append the
endpoint to the server base URL. Preserve path casing. Origin checks use
`CC_ALLOWED_ORIGINS`. Only the configured mode's socket is registered. These are
native WebSockets; there is no SockJS endpoint or HTTP long-poll fallback.
The HTTP session supplies the principal: STOMP `login`/`passcode` headers are not
a substitute for the cookie. The current configuration does not require a CSRF
header inside a STOMP CONNECT frame.

### P2S: STOMP over `/clipsocket`

Use a STOMP-capable WebSocket library (the bundled desktop client advertises
STOMP versions `1.0,1.1`). A connection proceeds as follows:

1. Upgrade to `/clipsocket` with the session cookie.
2. Send `CONNECT`; await `CONNECTED` before subscribing or sending.
3. `SUBSCRIBE` with a unique subscription ID to `/user/queue/cliptext`, normally
   `ack:auto`.
4. `SEND` to `/app/cliptext` with `content-type:application/json` and a clipboard
   envelope as the body.
5. Process `MESSAGE` frames for your subscription and tolerate heartbeat newlines.
6. On disconnect, repeat CONNECT and SUBSCRIBE; subscription IDs are local to a
   connection. Handle `ERROR` frames without trying to parse them as clipboard JSON.

Wire example (`\0` below means one NUL byte, not the two characters backslash/zero;
headers and the blank line use LF). Replace `host` with your server hostname:

```text
CONNECT
accept-version:1.2
host:localhost
heart-beat:0,20000

\0
```

```text
SUBSCRIBE
id:clipboard-0
destination:/user/queue/cliptext
ack:auto

\0
```

```text
SEND
destination:/app/cliptext
content-type:application/json

{"payload":"Hello from a client","type":"text"}\0
```

The last example is plaintext and interoperates with clients configured with
**encryption disabled**. For the default encrypted configuration use the encoding
section below. In real frames, there is no newline between the body and NUL.
When `content-length` is present it counts UTF-8 **body bytes**, excluding the
terminating NUL, not characters or the whole frame. JSON serialization must escape
embedded newlines/control characters. A stream parser must support multiple
frames per received chunk and frames split across chunks; use the declared length
when present and skip heartbeat newlines outside frames.

The server emits an envelope to connected, subscribed sessions of the **same
username, including the sender**. It preserves `payload`, `type`, and `metadata`;
missing/null `type` becomes `text`. Missing metadata can serialize as `null`.
The routing identity comes from authentication, not a username inside the payload.
There is no message ID, sequence number, durable acknowledgement, or delivery
confirmation in the application envelope. `ack:auto` needs no client ACK. Do not
build exactly-once or offline-delivery assumptions on STOMP transport receipts.

The simple broker advertises `heart-beat:20000,0`. With the client's
`heart-beat:0,20000`, expect server heartbeats during idle periods at roughly
20-second intervals; server-required client heartbeats are disabled. If another
pair is negotiated, respect it. External broker deployments can differ.
Use scheduling/network tolerance when detecting missed heartbeats.

### P2P: signaling over `/p2psignaling`

This socket exchanges JSON text messages without STOMP or NUL terminators.
The server creates one user room per authenticated username. Every connection
receives a fresh UUID peer ID, even when reconnecting from the same device.

```json
{"type":"ASSIGNED_ID","peerId":"<your peer UUID>"}
```

```json
{"type":"PEER_LIST","peers":["<your peer UUID>","<another peer UUID>"]}
```

`ASSIGNED_ID` is sent to the new connection before the handler broadcasts its
updated peer list. `PEER_LIST` includes yourself; array order is unspecified.
Lists are full snapshots, broadcast on connection and disconnection. Exclude
self, create connections for new peers, and dispose connections for removed peers.
There is no explicit JOIN, LEAVE, or fetch-peers command.

| Message | Sender → recipient | Required application fields |
| --- | --- | --- |
| `ASSIGNED_ID` | Server → new connection | `peerId`: string |
| `PEER_LIST` | Server → every connection in the user room | `peers`: array of strings |
| `OFFER` | Client → server → target peer | `fromPeerId`, `toPeerId`, `offer: {type:"offer", sdp:string}` |
| `ANSWER` | Client → server → target peer | `fromPeerId`, `toPeerId`, `answer: {type:"answer", sdp:string}` |
| `ICE_CANDIDATE` | Client → server → target peer | `fromPeerId`, `toPeerId`, `candidate: {candidate:string, sdpMid:string, sdpMLineIndex:integer}` |

Example offer and corresponding answer (SDP is abbreviated, not executable):

```json
{"type":"OFFER","fromPeerId":"peer-a","toPeerId":"peer-b","offer":{"type":"offer","sdp":"<complete local SDP>"}}
```

```json
{"type":"ANSWER","fromPeerId":"peer-b","toPeerId":"peer-a","answer":{"type":"answer","sdp":"<complete local SDP>"}}
```

```json
{"type":"ICE_CANDIDATE","fromPeerId":"peer-a","toPeerId":"peer-b","candidate":{"candidate":"candidate:1 1 udp 2130706431 192.0.2.10 50000 typ host","sdpMid":"0","sdpMLineIndex":0}}
```

The server routes only the three uppercase signaling types above, finds
`toPeerId` inside the authenticated user's room, and forwards the original JSON
unchanged. Missing/unknown targets and unknown types are silently ignored; there
is no error response or acknowledgement. It does **not** validate SDP or rewrite
or authenticate the supplied `fromPeerId`. Validate incoming sender/target IDs
against your current peer list and connection state. Malformed JSON can fail the
handler rather than producing a structured protocol error. Use text frames;
the handler also attempts to interpret binary frames as UTF-8 JSON.

#### WebRTC negotiation compatible with official clients

For each remote peer, maintain one `RTCPeerConnection`. Use the URL returned by
`/stun-url` as an ICE server URL when nonempty. The discovery API provides one
URL, not TURN credentials or a list of TURN servers. NAT/firewall conditions can
prevent direct connectivity; the server has no automatic TURN relay or P2S
fallback within a P2P deployment.

The official clients break offer collisions by comparing peer IDs
lexicographically: **the smaller peer ID initiates the offer**.

1. The initiator creates an ordinary reliable, ordered data channel named
   **`cliptext`**, then creates an offer and sets its local description.
2. Send the local SDP as `OFFER` to the larger peer ID. The answering client
   applies it as its remote description, creates and sets its local answer, and
   sends `ANSWER` back. The initiator applies that remote answer.
3. Accept the remote channel through the data-channel event on the answerer;
   do not create an extra channel there. Send nonempty ICE candidates through
   `ICE_CANDIDATE`. Do not send a null end-of-candidates marker to the desktop
   handler, which expects a candidate string. SDP can also contain gathered
   candidates (the desktop implementation sends its local description after
   setting it).
4. Queue early incoming candidates until the appropriate peer connection and
   remote description are ready. Apply only candidates/answers belonging to the
   current negotiation; stale messages can arrive after peer churn.
5. Wait for the data channel's `open` state before sending clipboard envelopes.
   Broadcast to each open remote channel. The server never relays these envelopes.

For recovery, official clients can replace a failed connection with a new offer;
this is a fresh negotiation, not necessarily an ICE-restart update on the old
connection. Close and replace stale peer state, preserve the smaller-ID initiator
rule, and avoid competing offers. On signaling reconnect, discard the old peer
ID, peer connections, and fragment buffers, then rebuild from the new assignment.

#### Data-channel heartbeat and fragmentation

Messages on `cliptext` are JSON strings. Ignore the following control message
before looking for `payload`, `type`, or `metadata`:

```json
{"_cc_keepalive":true}
```

Official clients send this roughly every 20 seconds on idle/live channels. It is
not a clipboard update, does not require a reply, and does not replace WebSocket
ping/pong on the signaling connection.

The clipboard envelope is the same as P2S, with fragmentation metadata:

```json
{
  "payload":"Hello",
  "type":"text",
  "metadata":{
    "id":"11111111-2222-4333-8444-555555555555",
    "isFragmented":false,
    "index":0,
    "totalFragments":1,
    "combinedRawPayloadSizeInBytes":5
  }
}
```

| Metadata field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Fresh transfer UUID; identical across its fragments and recipients |
| `isFragmented` | boolean | Whether more than one fragment was generated |
| `index` | integer | Zero-based fragment position |
| `totalFragments` | integer | Total fragment count (one for an unfragmented message) |
| `combinedRawPayloadSizeInBytes` | integer | UTF-8 size of the complete serialized plaintext payload **before encryption**, not the enclosing envelope or original file byte count |

Sender algorithm:

1. Serialize the content into the payload string described below. Record its
   UTF-8 length for `combinedRawPayloadSizeInBytes`.
2. If encryption is enabled, encrypt the **whole string once** and serialize the
   nonce/ciphertext/tag object into the new payload string.
3. Split that string into chunks of at most **15360 UTF-8 bytes** (15 KiB), without
   splitting a Unicode character. This limit excludes the outer JSON envelope;
   escaping can make the actual channel message larger.
4. Send one JSON envelope per chunk, in increasing index order, with the same
   ID/type/count/size and an incrementing `index`. Unfragmented messages still use
   the complete metadata object. Do not send an empty `{}` metadata object to an
   official P2P client: it expects the fields above when metadata is present.
5. Use data-channel buffered-amount/backpressure support to avoid unbounded queued
   sends. Finish one transfer before starting another for best interoperability.

Receiver algorithm:

1. Drop keepalive messages. Check types, count/index bounds, transfer identity,
   and local byte/count limits before allocating buffers.
2. Collect fragments by transfer ID (and sending peer in your own implementation).
   Require consistent metadata and join payload strings in index order only when
   all parts exist. Then parse/decrypt the combined encrypted payload, if enabled.
3. Decode the plaintext according to `type`. Never decrypt individual fragments
   or JSON-parse a partial encrypted payload string.
4. Discard abandoned buffers on disconnect or timeout; desktop expires partial
   buffers after 60 seconds without fragment activity. Bound actual accumulated
   bytes as well as the sender-declared size.

Official clients also accept an unfragmented envelope with missing/null metadata.
For compatibility, send ordered fragments: their receive logic expects completion
when the last-index fragment arrives and can discard incomplete/interleaved
transfers. A newly copied/received clipboard value can cancel in-flight work;
there is no fragment retry, acknowledgement, resume, or transfer-cancel message.
With encryption disabled, the official fragmenter emits no fragments for an empty
string, so do not depend on an empty P2P payload to clear other clients' clipboards.

#### Signaling liveness and limits

The server periodically sends RFC 6455 **ping control frames** every 40 seconds.
The client must respond with **pong control frames** (browser stacks handle this
internally). The handler checks for a recorded pong older than 120 seconds and
closes the socket with code `1001` at a heartbeat check. Ordinary JSON traffic,
a newline, or a data-channel keepalive does not update this pong timestamp.

P2P connections exceeding the configured global/per-user limits close with
`1008` (policy violation); a missing authenticated principal also closes this way.
The optional per-connection signaling limiter is a token bucket: capacity and
refill per second both equal `CC_P2P_SIGNALING_RATE_LIMIT_PER_SEC`. Values `<= 0`
disable it. Excess nonempty messages are silently dropped, with no retry hint.
Avoid rapid reconnect/offer loops and bursts of redundant candidates.

## Clipboard payload encoding and encryption

These are **client interoperability conventions**, not server-side content
validation. The P2S server treats the payload as a string and does not encrypt,
decrypt, inspect image bytes, or save uploaded files. P2P signaling does not see
clipboard content at all.

### Common envelope

| Field | Type | Contract |
| --- | --- | --- |
| `payload` | string | Serialized plaintext content or a serialized encrypted object; never a nested object |
| `type` | string | Official values are lowercase `text`, `image`, `files`; send explicitly |
| `metadata` | object or null, optional | P2P fragmentation fields above; passed through by P2S |

Do not infer encryption from the type: the type stays `text`, `image`, or `files`
even when encrypted. There is no encryption flag, algorithm version, key ID,
compression field, timestamp, MIME field, or sender-device ID in the standard
envelope. Unknown types/custom metadata have no official client behavior.

### Plaintext content formats

| Type | Plaintext payload string | Example / notes |
| --- | --- | --- |
| `text` | Original text | No Base64; preserve Unicode and line breaks |
| `image` | Standard Base64 of encoded image file bytes | No `data:image/...;base64,` prefix. Desktop preserves an existing image format or uses PNG; use PNG for broad compatibility. Not raw pixel bytes. |
| `files` | JSON string mapping base filenames to standard Base64 file contents | No ZIP, multipart upload, path hierarchy, or download URL |

Plaintext file envelope containing `hello.txt` with five bytes `Hello`:

```json
{"payload":"{\"hello.txt\":\"SGVsbG8=\"}","type":"files"}
```

Parse the outer JSON first, then parse `payload` as JSON for `files`; Base64-decode
each value separately. File keys are names such as `hello.txt`, not paths.
Duplicate basenames overwrite each other in the desktop sender's dictionary.
For an alternative receiver, constrain saves to its selected download directory,
reject path separators/traversal names, and resolve existing-file conflicts before
writing. Clipboard peers supply these names; the server does not sanitize them.
Feature support and clipboard permissions vary by platform; receiving data does
not guarantee an OS clipboard update or an automatic file save.

### Encryption derivation and wire representation

All clients sharing data must agree on the exact username, original password,
extra salt, iteration count, and encryption-enabled setting. Defaults in desktop
and mobile are encryption enabled, `664937` iterations, and empty extra salt.
These values are local configuration and are not stored/distributed by this API.

```text
loginCredential = lowercaseHex(SHA3-512(UTF8(originalPassword)))
key = PBKDF2-HMAC-SHA256(
    password = UTF8(originalPassword),
    salt = UTF8(username + originalPassword + extraSalt),
    iterations = configuredIterations,
    outputLength = 32 bytes
)
```

Concatenation has **no delimiter**. Do not substitute the login digest as the
PBKDF2 password, trim the extra salt, or add Unicode normalization.

Encrypt UTF-8 bytes of the serialized plaintext payload with AES-256-GCM using
that 32-byte key and a fresh random nonce for **every** encryption. No additional
authenticated data (AAD) is supplied. The authentication tag is 16 bytes.
The desktop's PyCryptodome call generates a nonce (normally 16 bytes); nonce length
is carried by the decoded field, so do not hard-code a 12-byte receive-only
assumption. Preserve the supplied nonce length when decrypting.

Encode nonce, ciphertext, and tag separately with standard padded Base64, then
JSON-serialize this object **into a string** for the outer `payload`:

```json
{"nonce":"<Base64 nonce>","ciphertext":"<Base64 ciphertext>","tag":"<Base64 16-byte authentication tag>"}
```

If your crypto API returns ciphertext with its tag appended, split the final 16
bytes before encoding. Reverse that step for an API expecting a combined input.
Verify authentication before decoding or applying plaintext. Do not silently fall
back to plaintext if decryption fails. The outer `type` and `metadata` are not
included as GCM AAD by the official clients.

Python implementation compatible with the desktop format (`pycryptodome`):

```python
import base64
import hashlib
import json
from Crypto.Cipher import AES


def derive_key(username, original_password, extra_salt="", rounds=664937):
    return hashlib.pbkdf2_hmac(
        "sha256",
        original_password.encode("utf-8"),
        (username + original_password + extra_salt).encode("utf-8"),
        rounds,
        dklen=32,
    )


def encrypt_payload(plaintext, key):
    cipher = AES.new(key, AES.MODE_GCM)  # Fresh random nonce each call.
    ciphertext, tag = cipher.encrypt_and_digest(plaintext.encode("utf-8"))
    return json.dumps({
        "nonce": base64.b64encode(cipher.nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "tag": base64.b64encode(tag).decode("ascii"),
    })


def decrypt_payload(payload, key):
    obj = json.loads(payload)
    parts = {name: base64.b64decode(obj[name], validate=True)
             for name in ("nonce", "ciphertext", "tag")}
    cipher = AES.new(key, AES.MODE_GCM, nonce=parts["nonce"])
    return cipher.decrypt_and_verify(parts["ciphertext"], parts["tag"]).decode("utf-8")


# Reuse username and raw_password from the login example.
# key = derive_key(username, raw_password)
# body = json.dumps({"payload": encrypt_payload("Hello", key), "type": "text"})
```

The complete transformation order is:

```text
Send: content → serialize to string → encrypt if enabled → fragment if P2P
      → wrap each payload string in an envelope → JSON → transport
Receive: transport → JSON envelope → reassemble if P2P → decrypt if enabled
         → decode text/image/files → update clipboard
```

### Reproducible encryption test vector

Use this fixed nonce **only in a test**; production encryption must generate a
fresh nonce. These values let a client in another language check the two password
derivations and AES-GCM encoding independently of a running server.

| Input | Value |
| --- | --- |
| Username | `alice` |
| Original password | `correct horse battery staple` |
| Extra salt | Empty string |
| Iterations | `664937` |
| Plaintext | `Hello 👋` (UTF-8, no trailing newline) |
| Nonce, hexadecimal | `000102030405060708090a0b0c0d0e0f` |

Expected login SHA3-512 digest:

```text
4b65d7b7acc886f9add07db3a5d42bf0032fe0109a1fd56f623c7093e8a59689f9246918a4f388034ddf393231eaba0742b3dc1840e4556270a729ce56098f35
```

Expected PBKDF2 key, hexadecimal (32 bytes):

```text
c6ffb459a9770f48246286649e2a7c5ed604796c0bb5319fb9064bfacb2595f5
```

Expected inner encryption object (JSON key order/whitespace may differ):

```json
{
  "nonce": "AAECAwQFBgcICQoLDA0ODw==",
  "ciphertext": "IKDCfNQa/57thQ==",
  "tag": "AaeI3kpRaOCTKz8b/Pusmw=="
}
```

Serialize this object into a string for `payload`; do not send it as an object.

### Echo and clipboard-loop suppression

The server has no deduplication or conflict resolution. Official clients track a
hash of the most recent serialized plaintext payload before send and before
applying received content. Desktop uses xxHash64; mobile uses xxHash32. These hashes
are local and are not sent, so an alternative client need not use the same hash
function. Compare content before encryption: random nonces make ciphertext change
on every encryption. Update your local suppression state before writing the OS
clipboard and avoid immediately retransmitting the received value.

### Minimal authenticated P2S send/receive example

Install `requests`, `websocket-client`, and `pycryptodome` in your own Python
virtual environment. Run the login example first, then the encryption helper
block, then this block in the same script. It sends one encrypted text update
and prints the first received text update (usually its own echo). This is a
protocol smoke test, not an OS clipboard monitor. All participating clients must
use the same encryption settings; change `cipher_enabled` and derivation parameters
here to match them. The example rejects P2P deployments instead of speaking the
wrong protocol.

```python
import json
import time
from urllib.parse import urlsplit, urlunsplit
import websocket


def authenticated_json(path):
    response = session.get(base + path, allow_redirects=False, timeout=15)
    if response.status_code != 200:
        raise RuntimeError(f"{path}: HTTP {response.status_code}")
    if "application/json" not in response.headers.get("Content-Type", ""):
        raise RuntimeError(f"{path}: expected JSON; check session")
    return response.json()


if authenticated_json("/server-mode")["mode"] != "P2S":
    raise RuntimeError("This example requires a P2S server")
max_size = authenticated_json("/max-size")["maxsize"]
cipher_enabled = True
key = derive_key(username, raw_password) if cipher_enabled else None
parts = urlsplit(base.rstrip("/"))
ws_url = urlunsplit(("wss" if parts.scheme == "https" else "ws",
                    parts.netloc, parts.path + "/clipsocket", "", ""))
# Ask requests to select cookies with the correct path/domain/Secure scope.
upgrade = session.prepare_request(requests.Request("GET", base + "/clipsocket"))
cookie_header = upgrade.headers.get("Cookie", "")
ws = websocket.create_connection(
    ws_url, cookie=cookie_header,
    origin=f"{parts.scheme}://{parts.netloc}", timeout=15,
)


def send_frame(command, headers, body=""):
    headers = {**headers, "content-length": str(len(body.encode("utf-8")))}
    wire = command + "\n" + "\n".join(f"{k}:{v}" for k, v in headers.items())
    ws.send(wire + "\n\n" + body + "\x00")


def frames():
    # Incremental parser for this example's LF-delimited STOMP 1.1 frames.
    # A production STOMP library should also handle CRLF and header escaping.
    buffer = b""
    while True:
        chunk = ws.recv()
        if not chunk:
            raise RuntimeError("WebSocket closed")
        buffer += chunk.encode("utf-8") if isinstance(chunk, str) else chunk
        while True:
            buffer = buffer.lstrip(b"\n")  # Ignore idle heartbeat bytes.
            split = buffer.find(b"\n\n")
            if split < 0:
                break
            lines = buffer[:split].decode("utf-8").split("\n")
            headers = dict(line.split(":", 1) for line in lines[1:])
            start = split + 2
            if "content-length" in headers:
                length = int(headers["content-length"])
                if length < 0:
                    raise RuntimeError("Invalid STOMP content-length")
                end = start + length
                if len(buffer) <= end:
                    break
                if buffer[end] != 0:
                    raise RuntimeError("Missing STOMP terminator")
            else:
                end = buffer.find(b"\x00", start)
                if end < 0:
                    break
            body = buffer[start:end].decode("utf-8")
            buffer = buffer[end + 1:]
            yield lines[0], headers, body


try:
    send_frame("CONNECT", {"accept-version": "1.1", "host": parts.hostname,
                           "heart-beat": "0,20000"})
    incoming = frames()
    command, headers, body = next(incoming)
    if command != "CONNECTED":
        raise RuntimeError(f"Expected CONNECTED, received {command}: {body}")
    send_frame("SUBSCRIBE", {"id": "clipboard-0",
                              "destination": "/user/queue/cliptext", "ack": "auto"})
    plaintext = "Hello from an alternative client 👋"
    if len(plaintext.encode("utf-8")) > max_size:
        raise RuntimeError("Text exceeds server clipboard limit")
    payload = encrypt_payload(plaintext, key) if cipher_enabled else plaintext
    send_frame("SEND", {"destination": "/app/cliptext",
                         "content-type": "application/json"},
               json.dumps({"payload": payload, "type": "text"}))
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        ws.settimeout(max(0.1, deadline - time.monotonic()))
        command, headers, body = next(incoming)
        if command == "ERROR":
            raise RuntimeError(body)
        if command == "MESSAGE":
            envelope = json.loads(body)
            if envelope.get("type", "text") == "text":
                value = envelope["payload"]
                print(decrypt_payload(value, key) if cipher_enabled else value)
                break
    else:
        raise RuntimeError("No text update received")
finally:
    ws.close()
```

This script closes the socket but leaves the HTTP login valid. To end that login,
use `session.post(base + "/logout", allow_redirects=False, timeout=15)` with the
CSRF header already set by the login example. For a continuously running client,
use a complete STOMP library, negotiated heartbeat deadlines, bounded input
buffers, retry/backoff, and the clipboard-loop suppression described above.

## Size limits and deployment configuration

`GET /max-size` reports the configured base size in bytes; default is `1048576`.
`GET /max-message-size` reports the same size in MiB, **floored to two decimal
places**. Use the byte value for calculations, especially for small limits.

For P2S, official clients check text UTF-8 bytes, encoded image file bytes, or
cumulative raw file bytes against the base limit before serialization. The server
sets WebSocket text/binary buffer limits, STOMP message/buffer limits, and Jackson's
JSON string limit to **twice the base size** to allow encoding overhead. Its STOMP
send time limit is 200000 ms. It does not separately reject a decoded clipboard
payload at the base limit in the message handler. JSON escaping, Base64, encryption,
filenames, and framing can still exceed the transport ceiling. Sending near the
limit can close a socket rather than return an HTTP `413` or structured JSON error.
P2S has no application-level fragment reassembly; do not reuse P2P fragment envelopes
to bypass its limit when communicating with official clients.

For P2P, these base-size discovery endpoints still return configured values, but
clipboard data bypasses the server. Official desktop switches its server clipboard
limit to `-1` in this mode and relies on local limits. The P2S buffer configuration
is conditional and does not configure the P2P signaling endpoint; do not infer its
maximum SDP size from `/max-size`. Apply your own transfer/buffer limits and account
for runtime, proxy, and WebRTC message limits.

Client-relevant server settings (defaults from this tree):

| Environment variable | Default | Effect |
| --- | --- | --- |
| `CC_PORT` | `8080` | HTTP listening port |
| `CC_P2P_ENABLED` | `false` | Selects P2P instead of P2S |
| `CC_ALLOWED_ORIGINS` | `*` | WebSocket allowed origin value; not HTTP CORS |
| `CC_MAX_MESSAGE_SIZE_IN_MiB` | `1` | Base message size when byte override is not positive; nonpositive MiB falls back to 1 |
| `CC_MAX_MESSAGE_SIZE_IN_BYTES` | `0` | Positive value overrides MiB setting |
| `CC_P2P_STUN_URL` | `stun:stun.l.google.com:19302` | P2P ICE discovery URL |
| `CC_MAX_WS_GLOBAL_CONNECTIONS` | `-1` | P2P global connection cap; `-1` unlimited |
| `CC_MAX_WS_CONNECTIONS_PER_USER` | `-1` | P2P per-user connection cap; `-1` unlimited |
| `CC_P2P_SIGNALING_RATE_LIMIT_PER_SEC` | `-1` | P2P token bucket; nonpositive disables |
| `CC_SESSION_TIMEOUT` | `525960m` | HTTP session inactivity timeout |
| `CC_SESSION_PERSISTENCE_ENABLED` | `false` | Opt-in JDBC sessions, H2/PostgreSQL |
| `CC_SIGNUP_ENABLED` | `false` | Public registration and captcha |
| `CC_CAPTCHA_DIFFICULTY_PERCENT` | `100` | Captcha presentation difficulty, clamped to 0–100 |
| `CC_MAX_USER_ACCOUNTS` | `-1` | Total account cap including admin; `-1` unlimited |
| `CC_ACCOUNT_PURGE_TIMEOUT_SECONDS` | `-1` | Inactive non-admin cleanup at startup; negative disables |
| `CC_MAX_UNIQUE_IP_ATTEMPTS` | `15` | Brute-force tracker unique-IP threshold |
| `CC_MAX_ATTEMPTS_PER_IP` | `30` | Brute-force tracker per-IP threshold |
| `CC_LOCK_TIMEOUT_SECONDS` | `60` | Brute-force lockout base duration |
| `CC_LOCK_TIMEOUT_SCALING_FACTOR` | `2` | Per-IP lock duration scaling |
| `CC_EXTERNAL_BROKER_ENABLED` | `false` | P2S external STOMP broker relay |
| `CC_BROKER_HOST` / `CC_BROKER_PORT` | `localhost` / `61613` | Backend broker connection; clients still use `/clipsocket` |
| `CC_BROKER_USERNAME` / `CC_BROKER_PASSWORD` | `admin` / `admin` | Server-to-broker credentials, not client HTTP credentials |
| `CC_DONATIONS_ENABLED` | `false` | Donation link behavior |

Database, logging, and BFA cache settings are operator settings documented in the
[server configuration guide](../README.md#-server-configuration) and
[application properties](ClipCascade_Backend/src/main/resources/application.properties).
Clients cannot change server configuration through an API endpoint. Treat settings
as deployment-specific; most are not exposed by the small discovery API.

Brute-force failures/disabled accounts normally reach the same login error flow;
there is no client-facing structured lockout duration or `Retry-After` contract.
Stop automatic bad-credential retries and let the user resolve credentials or
ask an admin to inspect/unlock the account.

## Recovery and troubleshooting

Reconnect with backoff and jitter. Revalidate the HTTP session after transport
failure or sleep. If authenticated, rediscover mode/limits as needed and recreate
the socket; if unauthenticated, obtain a new login CSRF token, authenticate, and
replace cookies and the authenticated CSRF token. Never keep reconnecting with a
known-revoked cookie. Deliberate logout must disable automatic reconnection.

| Symptom | Checks / action |
| --- | --- |
| A JSON endpoint returns HTML or a redirect | Disable automatic redirects during diagnosis; check `/whoami`, cookie scope, and session expiry. A followed `200` login page is not success. |
| Login redirects to `?error` | Check exact username, lowercase SHA3-512 of original UTF-8 password, enabled status, and lockout. Do not double-hash the digest. |
| Mutation returns `403` | Fetch a fresh CSRF token for the same session and use its named header; admin session-logout routes also return `403` for non-admins. |
| Admin route returns `400 Forbidden` | Verify `/whoami` reports `ADMIN`; most controller checks use `400`, not `403`. |
| WebSocket upgrade fails | Confirm mode/path, cookie, origin, proxy Upgrade support, TLS trust, and authentication. A public `/health` success does not establish a valid login. |
| STOMP connects but receives nothing | Wait for CONNECTED; subscribe to `/user/queue/cliptext`; send to `/app/cliptext`; compare usernames and check encoding settings. |
| P2S disconnects only on large clipboard updates | Measure serialized UTF-8 frame size, Base64/GCM overhead, broker/proxy limits, and `/max-size`. |
| P2P peer list appears but channel never opens | Check initiator ordering, SDP/candidate exchange, candidate timing, STUN/network reachability, and NAT constraints. Signaling presence is not channel readiness. |
| P2P negotiation intermittently stalls | Check signaling rate-limit drops, stale peer IDs, and conflicting recovery offers. |
| P2P disconnects after idle time | Respond to WebSocket ping with pong; data-channel traffic cannot satisfy signaling heartbeat checks. |
| Decryption/JSON errors | Align encryption enabled, original password, username, extra salt, and iterations; check Base64 fields and ciphertext/tag splitting. |
| Partial files or transfers never finish | Enforce ordered UTF-8-safe fragmentation, same metadata per transfer, complete reassembly before decrypt, and avoid interleaved transfers. |
| Clipboard repeats indefinitely | Suppress local events from received content and the sender's P2S echo, using plaintext comparisons. |
| Renamed/deleted username cannot be registered again | User-info records can reserve a name until startup purges records marked for deletion. |

No catch-up endpoint exists. A reconnect can miss updates while offline; choose
an explicit local policy for whether to send the current clipboard after reconnect
instead of assuming the server holds the latest value.

## Interoperability acceptance checklist

Use two sessions on the same account, plus a separate account to check routing.
Run against both server modes and, where relevant, against desktop and mobile.
These are implementation acceptance checks, not claims of automated test coverage.

- [ ] Login succeeds with a digest and fails with an incorrect credential; JSON
      checks detect redirects/HTML and CSRF tokens are refreshed after re-login.
- [ ] Signup retains its captcha session, handles consumed challenges, and logs
      in separately after successful registration.
- [ ] Same-account sessions exchange text; separate accounts do not receive the
      application's user-targeted clipboard messages.
- [ ] Unicode, emoji, multiline text, and quotes survive JSON and STOMP byte counts.
- [ ] Encryption round-trips with official clients, including matching nondefault
      salt/iterations; mismatched settings and altered tags fail without pasting.
- [ ] PNG images and multiple files decode correctly; filenames and file contents
      survive the extra JSON/Base64 layers.
- [ ] P2S echo does not cause clipboard loops; reconnection resubscribes.
- [ ] P2P initiator ordering works with either peer joining first; peer departure,
      sleep/resume, and fresh IDs remove stale connections.
- [ ] P2P payloads below/above 15360 bytes and multibyte characters at chunk
      boundaries reassemble; keepalive messages never modify the clipboard.
- [ ] Incomplete/invalid fragments are bounded and discarded; local size limits
      work even when sender metadata understates the actual size.
- [ ] Near-limit P2S data and excess P2P connections/rate limits fail gracefully.
- [ ] Password/status/name changes and admin logout revoke sessions; clients close
      direct channels and do not automatically reconnect using stale credentials.
- [ ] Restart is handled with both in-memory and persistent sessions; a live HTTP
      session never leads the client to reuse a dead socket or old subscription.

## Implementation sources

When changing the protocol, update this guide alongside these sources:

- [HTTP routes and STOMP message handler](ClipCascade_Backend/src/main/java/com/acme/clipcascade/controller/ClipCascadeController.java)
- [Authentication and access rules](ClipCascade_Backend/src/main/java/com/acme/clipcascade/config/SecurityConfiguration.java)
- [Session persistence and cookies](ClipCascade_Backend/src/main/java/com/acme/clipcascade/config/SessionPersistenceConfiguration.java)
- [Session revocation](ClipCascade_Backend/src/main/java/com/acme/clipcascade/service/SessionService.java)
- [Live socket revocation](ClipCascade_Backend/src/main/java/com/acme/clipcascade/service/LiveWebSocketService.java)
- [User validation](ClipCascade_Backend/src/main/java/com/acme/clipcascade/utils/UserValidator.java)
- [Pagination](ClipCascade_Backend/src/main/java/com/acme/clipcascade/utils/PagingUtility.java)
- [STOMP configuration](ClipCascade_Backend/src/main/java/com/acme/clipcascade/config/StompWebSocketConfig.java)
- [P2P signaling handler](ClipCascade_Backend/src/main/java/com/acme/clipcascade/config/P2PWebSocketHandler.java)
- [Configuration and size calculations](ClipCascade_Backend/src/main/java/com/acme/clipcascade/config/ClipCascadeProperties.java)
- [Official desktop HTTP client](../ClipCascade_Desktop/src/utils/request_manager.py)
- [Desktop credential preparation](../ClipCascade_Desktop/src/core/application.py)
- [Desktop STOMP client](../ClipCascade_Desktop/src/stomp_ws/stomp_manager.py)
- [Desktop P2P and fragmentation](../ClipCascade_Desktop/src/p2p/p2p_manager.py)
- [Desktop encryption](../ClipCascade_Desktop/src/utils/cipher_manager.py)
- [Desktop image/file serialization](../ClipCascade_Desktop/src/clipboard/clipboard_manager.py)
- [Desktop configuration defaults](../ClipCascade_Desktop/src/core/config.py)
- [Mobile key derivation](../ClipCascade_Mobile/src/App.js)
- [Mobile encryption, WebRTC, and fragmentation](../ClipCascade_Mobile/src/StartForegroundService.js)
