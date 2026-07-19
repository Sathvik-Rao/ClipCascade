# ClipCascade on Tailscale

Recommended way to self-host ClipCascade across your devices **without** opening ports on the public internet.

Tailscale provides wire encryption and private addressing (`100.64.0.0/10` CGNAT + MagicDNS `*.ts.net`). ClipCascade clients treat those as trusted private mesh and allow **HTTP** there. For any server reachable on the public internet, use **HTTPS**.

## 1. Install Tailscale

Install and log in on:

- The machine that will run the ClipCascade **server**
- Every desktop / phone client

Confirm nodes see each other:

```bash
tailscale status
# note the server's 100.x.y.z address and MagicDNS name
```

## 2. Run the server (Docker)

Minimal env (generate strong secrets yourself):

```bash
export CLIPCASCADE_IMAGE=your-registry/clipcascade:3.2.0
export CC_INITIAL_ADMIN_PASSWORD='your-strong-admin-password'
export CC_SERVER_DB_PASSWORD='file-pass user-pass'

# Use the URL clients will open. Prefer MagicDNS.
# Example: http://homeserver.tail-XXXX.ts.net:8080
export CC_ALLOWED_ORIGINS="http://homeserver.tail-XXXX.ts.net:8080,http://100.x.y.z:8080"

cd ClipCascade_Server/docker-compose
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up -d
```

`docker-compose.tailscale.yml` documents bind addresses and comments for optional Tailscale Serve.

### Origins

`CC_ALLOWED_ORIGINS` is a **comma-separated** list. Include every origin the browser will use:

```text
http://100.64.1.10:8080,http://clipcascade.tail-abc123.ts.net:8080
```

Do **not** use `*`.

### Optional: Tailscale Serve (HTTPS name on the tailnet)

If you terminate TLS with Tailscale Serve:

```bash
sudo tailscale serve --bg 8080
# clients use https://<machine>.ts.net
```

Then set:

```bash
export CC_ALLOWED_ORIGINS="https://homeserver.tail-XXXX.ts.net"
```

And point clients at `https://homeserver.tail-XXXX.ts.net` (no port if Serve uses 443).

## 3. Desktop client

Server URL examples (HTTP allowed on mesh):

| URL | Notes |
|-----|--------|
| `http://100.64.1.10:8080` | Tailscale IP |
| `http://homeserver.tail-XXXX.ts.net:8080` | MagicDNS |
| `http://192.168.1.50:8080` | LAN |
| `https://clipcascade.example.com` | Public / reverse proxy |

Keep **Enable Encryption** on.

Env overrides (optional):

| Variable | Default | Meaning |
|----------|---------|---------|
| `CLIPCASCADE_ALLOW_PRIVATE_HTTP` | `true` | Allow HTTP to private/Tailscale hosts |
| `CLIPCASCADE_ALLOW_INSECURE_HTTP` | unset | Force-allow HTTP to **any** host (not recommended) |

## 4. Mobile client

- Android: cleartext to private/Tailscale hosts is enabled via `network_security_config` (needed for `http://100.x…`).
- Enter the same Server URL as desktop.
- Use Share / Quick Settings tile / notification **Share clipboard now** to push clipboard content.

## 5. Mode recommendation

| Mode | On Tailscale |
|------|----------------|
| **P2S** (default) | **Preferred.** Server on one node; all clients WebSocket to it over the tailnet. Simple, works through CGNAT. |
| **P2P** | Optional. Still needs STUN for ICE in many networks; on a clean tailnet host candidates often work. Prefer P2S unless you need server-offload. |

Set `CC_P2P_ENABLED=false` unless you intentionally want P2P.

## 6. ACLs (optional)

Lock ClipCascade to tagged devices in `policy.hujson`:

```json
{
  "tagOwners": {
    "tag:clipcascade": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:clipcascade"],
      "dst": ["tag:clipcascade:8080"]
    }
  ]
}
```

Tag the server and clients accordingly.

## 7. Checklist

- [ ] Server bound / published on port 8080 and reachable via `tailscale ping`
- [ ] `CC_INITIAL_ADMIN_PASSWORD` and `CC_SERVER_DB_PASSWORD` set
- [ ] `CC_ALLOWED_ORIGINS` matches exact client origins (scheme + host + port)
- [ ] Desktop/mobile use Tailscale IP or `*.ts.net` URL
- [ ] Client encryption enabled
- [ ] Signup disabled (`CC_SIGNUP_ENABLED=false`) unless you want open registration
- [ ] No public port-forward required

## 8. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Desktop: “Refusing insecure HTTP for non-private server” | Use `100.x` / `*.ts.net` / LAN IP, or HTTPS |
| Browser WS fails / CORS | Add that exact origin to `CC_ALLOWED_ORIGINS` and restart |
| Android cannot load `http://100…` | Rebuild app with network security config from this branch |
| MagicDNS not resolving | Enable MagicDNS in Tailscale admin; use 100.x IP as fallback |
| Session lost after server restart | Expected; re-login or enable local password save (not recommended on shared machines) |

See also: `SECURITY_SELF_HOST.md`, `ClipCascade_Server/docker-compose/.env.example`.
