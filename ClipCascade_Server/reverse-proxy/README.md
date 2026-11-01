# ClipCascade reverse-proxy setup

These are repository configuration examples, not packaged release downloads.
Local server/proxy connection checks have passed; public certificate issuance,
an actual NPM installation, and real-device clipboard transfer still need
deployment-specific validation.

Choose **one** proxy below. Each bundled setup runs ClipCascade plus that proxy,
keeps the database in `./cc_users`, and exposes only the proxy to the internet.
Use an existing-proxy option if something already owns ports 80/443.

The backend network allows outbound connections for server update checks.
The backend port is not published by the bundled proxy setups.

| Your setup | Files / instructions |
| --- | --- |
| Nginx, with a certificate you already manage | [Nginx](#nginx) |
| Traefik, automatic public HTTPS certificates | [Traefik](#traefik) |
| Caddy, automatic public HTTPS certificates | [Caddy](#caddy) |
| Nginx Proxy Manager (NPM) | [Nginx Proxy Manager](#nginx-proxy-manager) |
| A proxy you already run | [Existing proxy](#existing-proxy) |

## Before starting

1. Install Docker with the `docker compose` plugin. Clone this repository or copy
   this entire directory, including subdirectories and `.env.example`. From a clone:

   ```sh
   cd ClipCascade_Server/reverse-proxy
   cp .env.example .env
   ```

2. Edit `.env`: set `DOMAIN` to your own hostname, with **no** `https://`, port,
   or path. Set `ACME_EMAIL` to your email for Traefik/Caddy. These examples use
   a dedicated hostname such as `clipboard.example.com`, not `/clipcascade`.
3. Point DNS to this host and allow/forward TCP 80 and 443 to it. Automatic public
   certificates require a public domain and internet-reachable challenge ports.
   Fix unreachable IPv6/AAAA records too. `.local`, private IPs, and hosts-file
   aliases need a certificate you manage; use Nginx for that setup.
4. Start **one** of the commands below. In every client, enter the final public URL,
   e.g. `https://clipboard.example.com`, not the backend URL or `/login`.
5. Log in to the web interface as `admin` / `admin123` and change the password.
   Create user accounts there. Keep signup disabled unless you intend to offer it.

Allow the server a few seconds to start; a temporary 502 immediately after
`up -d` can mean it is still initializing. Use the log commands below if it persists.

The examples use `sathvikrao/clipcascade:latest` by default. Keep clients compatible
with the server when updating. To use a specific server version, set
`CLIPCASCADE_IMAGE=sathvikrao/clipcascade:<version>` in `.env`.

**Existing installation:** back up the current database and keep the same database
credentials. These files create a new installation unless you change the volume
source `./cc_users` in `compose.yml` to your existing database directory. Do not
run two servers against the same H2 files. Stop the old server before moving it.

## Nginx

Put the certificate chain in `certs/fullchain.pem` and its private key in
`certs/privkey.pem`, or set `NGINX_CERT_DIR` to the directory containing those files.
The certificate must cover `DOMAIN`. Keep the key private.

```sh
docker compose -f compose.yml -f compose.nginx.yml config --quiet
docker compose -f compose.yml -f compose.nginx.yml up -d
docker compose -f compose.yml -f compose.nginx.yml exec nginx nginx -t
```

[The template](nginx/default.conf.template) handles login, HTTP APIs, `/clipsocket`,
and `/p2psignaling` in one location. It forwards the original host including its
port, supplies HTTPS information, and allows long-lived WebSockets. No separate
WebSocket hostname, Origin removal, or `proxy_set_header Location` is needed.

Renew certificates using your existing certificate manager. After renewal:

```sh
docker compose -f compose.yml -f compose.nginx.yml exec nginx nginx -s reload
```

**Custom HTTPS port:** set `HTTPS_PORT=8743` in `.env`, allow/forward TCP 8743,
and enter `https://clipboard.example.com:8743` in every client. The internal TLS
port stays 443; the forwarded port and HTTP redirect use **8743**. Do not substitute
the container's `$server_port` for the public port. This also works when ports 80
and 443 cannot be opened, provided you already have a valid certificate.

For Nginx installed directly on the host, use the
[host-proxy overlay](compose.host-proxy.yml), adapt the template's upstream to
`127.0.0.1:8080`, remove Docker's `resolver`/`resolve` configuration, and replace
`${DOMAIN}` / `${HTTPS_PORT}` with actual values. Mount/include this configuration
in Nginx's `http` context. Keep its map, upstream, HTTP server, and HTTPS server.

## Traefik

```sh
docker compose -f compose.yml -f compose.traefik.yml config --quiet
docker compose -f compose.yml -f compose.traefik.yml up -d
docker compose -f compose.yml -f compose.traefik.yml logs --tail=100 traefik
```

Traefik obtains and renews a Let's Encrypt certificate using HTTP challenge on
public port 80. Keep its `traefik_certs` volume. Its file provider routes the whole
hostname to ClipCascade and supports HTTP and WebSockets without special upgrade
middleware. It needs no Docker socket mount or exposed dashboard.

The bundled `clipcascade-https` middleware normalizes `X-Forwarded-Proto` to
`https` on the TLS router. Traefik otherwise sends `wss` for WebSocket upgrades,
which can make Spring's login redirect throw `Unsupported scheme 'wss'` when a
session is missing/expired. Keep this middleware when adapting the file to an
existing Traefik installation.
See [Traefik's forwarding-scheme discussion](https://github.com/traefik/traefik/issues/6388)
for the upstream behavior.

For a custom public HTTPS port, set `HTTPS_PORT`, include that port in clients,
and keep public port 80 available for certificate issuance/renewal. HTTP redirects
use the configured public port. If public port 80 is unavailable, use your own
certificate with Nginx or adapt Traefik to your existing DNS-challenge resolver.

## Caddy

```sh
docker compose -f compose.yml -f compose.caddy.yml config --quiet
docker compose -f compose.yml -f compose.caddy.yml up -d
docker compose -f compose.yml -f compose.caddy.yml logs --tail=100 caddy
```

Caddy obtains/renews a public certificate and forwards WebSockets automatically.
Keep the `caddy_data` and `caddy_config` volumes. The explicit HTTP redirect retains
`HTTPS_PORT`. For a custom public HTTPS port, keep public port 80 reachable for
HTTP certificate challenges; use Nginx with an existing certificate if challenges
cannot reach this host. Do not disable TLS verification to make a client connect.

## Existing proxy

For a **containerized** proxy, find its Docker network (`docker network ls`) and
set `PROXY_NETWORK` in `.env` to that existing network:

```sh
docker compose -f compose.yml -f compose.existing-proxy.yml up -d
```

Set your proxy's upstream to **`http://clipcascade:8080`** on that network. A proxy
container's `localhost` refers to itself. For Traefik, adapt
[the dynamic configuration](traefik/clipcascade.yml) to your existing entrypoint,
certificate resolver, and hostname (replace the Go template if your existing
Traefik process does not have `DOMAIN` set). Add no browser SSO middleware.

For a proxy running **directly on the Docker host**, use:

```sh
docker compose -f compose.yml -f compose.host-proxy.yml up -d
```

Its upstream is `http://127.0.0.1:8080`. This publishes the backend only on loopback.
For a proxy on a different machine, use a private network address and firewall the
backend to that proxy; do not publish a forwarded-header-trusting backend to the
internet. Do not layer a second bundled proxy over an existing proxy accidentally.

Both options already set `SERVER_FORWARD_HEADERS_STRATEGY=framework` on the
**ClipCascade server**. The **proxy** must also send the original host, HTTPS
scheme, and public port. Never trust client-supplied forwarded headers at the edge.
If adding a CDN/tunnel in front, explicitly configure trust for that hop; the
bundled Nginx template assumes it is the HTTPS edge.

## Nginx Proxy Manager

Use the existing-container-proxy setup above and set NPM's Proxy Host fields:

| Field | Value |
| --- | --- |
| Domain Names | Your `DOMAIN` |
| Scheme | **http** (ClipCascade's internal listener) |
| Forward Hostname / IP | `clipcascade`, on the shared Docker network |
| Forward Port | `8080` |
| Websockets Support | **Enabled** |
| Cache Assets | **Disabled** while configuring/testing |
| Access List | **Publicly Accessible**; ClipCascade still requires its own login |
| SSL certificate | Request/select a certificate for this hostname |
| Force SSL | **Enabled** |

NPM's **Advanced** tab accepts server-context directives. The optional
[advanced snippet](nginx-proxy-manager/advanced.conf) adds idle timeouts. Do not
paste a whole `server`, `map`, or duplicate `location /` into that tab; NPM
generates those blocks. Start without custom locations so **both** WebSocket
endpoints inherit the generated upgrade settings. If old custom locations exist,
remove/fix them rather than only patching `/clipsocket`.

For a nonstandard HTTPS port, prefer the bundled Nginx setup: the public Host and
port must survive NPM's generated configuration, not merely its host port mapping.
Do not use an HTTP upstream with NPM's scheme set to HTTPS.

## Verify login and the live connection

Loading the login page only tests one part of the connection. This checker follows
the native-client sequence: CSRF page → password digest → session verification →
server mode → authenticated WebSocket → STOMP or P2P initialization.

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python check_connection.py https://clipboard.example.com --username alice
```

It prompts for your password; it does not save/print passwords, digests, cookies,
or raw HTTP headers. It refuses redirects that change the public scheme, hostname,
or port, rather than following a broken HTTP redirect silently.

- Custom port: use `https://clipboard.example.com:8743`.
- Private CA: add `--ca-bundle /path/to/ca-bundle.pem`. Import the same CA bundle
  in Android or set the Desktop **CA bundle** option. A browser trusting the CA
  does not establish that each native client trusts it.
- Only native clients fail: try `--direct` to bypass local `HTTP_PROXY`,
  `HTTPS_PROXY`, and `ALL_PROXY` settings. This diagnoses a local outbound proxy;
  it does not change ClipCascade Desktop's proxy configuration.
- Repeated disconnects: add `--hold-seconds 90`. This checks an established
  connection through an idle interval without broadcasting clipboard data.
- A P2P check confirms **signaling**, not a direct WebRTC data channel. Test two
  devices on different networks. If NAT/firewalls prevent direct traffic, use
  `CC_P2P_ENABLED=false` (P2S); an HTTP proxy cannot repair WebRTC reachability.

Use the **same account**, server mode, and encryption settings on two clients,
then copy different text each time and check both directions. On Android, follow
the clipboard monitoring permissions/workarounds in the main README; a connected
WebSocket does not give Android permission to read the clipboard.

## Browser SSO, Cloudflare, and network boundaries

Native clients use ClipCascade's own username/password/session login. They do not
complete a browser-only SSO, MFA, Cloudflare Access, or bot-challenge page.
Allowing just `/login` and the socket endpoints is insufficient: clients also
need `/`, `/validate-session`, `/csrf-token`, `/server-mode`, mode/config routes,
and other authenticated APIs. Prefer a dedicated client hostname that bypasses
the **external** authentication layer for the whole ClipCascade application, while
retaining ClipCascade authentication and normal network access controls. Keep any
SSO-protected browser hostname separate. This does not add OIDC support.

For Cloudflare Tunnel, route the entire hostname to `http://clipcascade:8080` on a
shared network (or a backend address reachable from cloudflared). Enable WebSocket
support and ensure Access/WAF rules do not replace native-client responses with
interactive HTML. Retain TLS verification when the upstream itself uses HTTPS.
Use a DNS-only/direct connection as a diagnostic to isolate tunnel/CDN behavior.

`localhost` is the device where the client runs. On a phone it is the phone, and in
NPM it is the NPM container. Use the server's reachable hostname/IP. For a local
Desktop test, `127.0.0.1` can avoid IPv4/IPv6 localhost differences.

## Troubleshooting reports

| Symptom | What to inspect / do |
| --- | --- |
| Redirect to HTTP, `http://host:443`, or missing `:8743` | Forward the public scheme/host/port and enable Spring forwarding. Do not rely on port-80 redirects to repair a broken login redirect. |
| “No Set-Cookie header” on an older Android release | Update the client and check cookie/forwarding settings. A session can be reused without issuing a fresh cookie; cookies alone do not prove authentication. |
| Wrong password | Correct it; the updated client reports the credentials error separately. Repeated attempts can trigger temporary lockout. |
| Page loads, WebSocket fails | Check the **actual mode's** endpoint and its handshake in proxy/server logs. Expected status is **101**. |
| Handshake 302 / login HTML | Session cookie is missing/expired or external SSO intercepts it. |
| Handshake 403 | Check allowed origin, session authorization, and access policy. Do not strip Origin as a blanket workaround. |
| 502 / 504 | Check upstream protocol, address, port, Docker network, and server readiness. |
| Drop after a regular interval | Check proxy timeouts, heartbeat traffic, network changes, and session expiry. |
| Breaks after a server restart | Default sessions are in memory. Log in again, or opt into `CC_SESSION_PERSISTENCE_ENABLED=true` with durable database storage. |
| P2P is connected but cannot transfer | Test WebRTC/NAT reachability; switch to P2S to isolate that from proxy problems. |

View logs with the **same files** used to start your stack, for example:

```sh
docker compose -f compose.yml -f compose.nginx.yml logs --tail=100 clipcascade nginx
```

Checkers and configuration cannot diagnose every generic WebSocket event. Report
the app/server versions, public scheme and port, proxy type, failure time, checker
stage, and handshake status. Remove passwords, tokens, and Cookie/Set-Cookie
headers before sharing logs. Public-server users cannot change its proxy settings.

## Why these files exist

These examples address the patterns reported in
[#61](https://github.com/Sathvik-Rao/ClipCascade/issues/61) and
[#93](https://github.com/Sathvik-Rao/ClipCascade/issues/93) (NPM/WebSocket setup),
[#38](https://github.com/Sathvik-Rao/ClipCascade/issues/38) and
[#128](https://github.com/Sathvik-Rao/ClipCascade/issues/128) (HTTP redirects after HTTPS login),
[#133](https://github.com/Sathvik-Rao/ClipCascade/issues/133) (custom public ports),
[#119](https://github.com/Sathvik-Rao/ClipCascade/issues/119) and
[#144](https://github.com/Sathvik-Rao/ClipCascade/issues/144) (Android cookies),
[#107](https://github.com/Sathvik-Rao/ClipCascade/issues/107) (SSO interception),
[#143](https://github.com/Sathvik-Rao/ClipCascade/issues/143) (private CAs), and
[#159](https://github.com/Sathvik-Rao/ClipCascade/issues/159) (browser works but native sockets time out).
These are recurring symptoms, not evidence that every report has the same cause.
Other reports have causes outside the reverse proxy:
[#32](https://github.com/Sathvik-Rao/ClipCascade/issues/32) included an incorrect
Python WebSocket package, [#109](https://github.com/Sathvik-Rao/ClipCascade/issues/109)
described sessions lost after server restart, and
[#129](https://github.com/Sathvik-Rao/ClipCascade/issues/129) involved localhost
address resolution. Changing Nginx cannot resolve every connection failure.

References: [Spring forwarding](https://docs.spring.io/spring-boot/how-to/webserver.html#howto.webserver.use-behind-a-proxy-server),
[Nginx WebSockets](https://nginx.org/en/docs/http/websocket.html),
[Traefik file provider](https://doc.traefik.io/traefik/v3.6/reference/install-configuration/providers/others/file/),
[Traefik ACME](https://doc.traefik.io/traefik/v3.6/reference/install-configuration/tls/certificate-resolvers/acme/),
[Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[NPM shared networks](https://nginxproxymanager.com/advanced-config/).
