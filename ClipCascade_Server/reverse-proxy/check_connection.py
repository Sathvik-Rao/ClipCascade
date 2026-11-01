"""Check the native-client login and WebSocket path without sharing secrets."""

import argparse
import getpass
import hashlib
from html.parser import HTMLParser
import json
import os
import ssl
import sys
import time
from urllib.parse import urlsplit, urlunsplit

import requests
import websocket


class CheckFailed(Exception):
    pass


def origin(url):
    parts = urlsplit(url)
    return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)


class ClientSession(requests.Session):
    """Reject redirects that lose HTTPS, the hostname, or a nonstandard port."""

    def __init__(self, base_url):
        super().__init__()
        self.expected_origin = origin(base_url)

    def get_redirect_target(self, response):
        target = super().get_redirect_target(response)
        if target:
            from urllib.parse import urljoin
            if origin(urljoin(response.url, target)) != self.expected_origin:
                raise CheckFailed(
                    "Redirect changed the public scheme, host, or port. "
                    "Check forwarded headers and SERVER_FORWARD_HEADERS_STRATEGY=framework. "
                    "An external SSO redirect also blocks native clients."
                )
        return target


class CsrfParser(HTMLParser):
    token = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "input" and attrs.get("name") == "_csrf":
            self.token = attrs.get("value")


def request(session, method, url, **kwargs):
    response = session.request(method, url, timeout=15, **kwargs)
    if response.status_code >= 400:
        hints = {
            400: "Check HTTPS scheme, public port, and forwarded headers.",
            401: "Check authentication and external proxy access policies.",
            403: "Check CSRF/session cookies, origin restrictions, and proxy access policies.",
            502: "The proxy cannot reach its upstream. Check its hostname, network, and port.",
            504: "The upstream did not respond in time. Check server/proxy logs.",
        }
        raise CheckFailed(f"HTTP {response.status_code}. " + hints.get(response.status_code, "Check server/proxy logs."))
    return response


def login(session, base_url, username, password):
    page = request(session, "GET", base_url + "/login")
    parser = CsrfParser()
    parser.feed(page.text)
    if not parser.token:
        raise CheckFailed("Login page has no CSRF token. Check the URL, SSO, and proxy challenge pages.")
    print("PASS: ClipCascade login page and CSRF token received.")
    response = request(session, "POST", base_url + "/login", data={
        "username": username,
        "password": hashlib.sha3_512(password.encode("utf-8")).hexdigest(),
        "_csrf": parser.token,
    })
    if "bad credentials" in response.text.lower():
        raise CheckFailed("Incorrect username or password (or the account is temporarily locked).")
    validation = request(session, "GET", base_url + "/validate-session")
    if validation.text != "OK":
        raise CheckFailed("Session was not authenticated. Check credentials, cookies, and proxy access policies.")
    print("PASS: Credentials accepted and authenticated session verified.")


def check_websocket(session, base_url, ca_bundle=None, direct=False, hold_seconds=0):
    mode_response = request(session, "GET", base_url + "/server-mode")
    try:
        mode = mode_response.json()["mode"]
    except (ValueError, KeyError, TypeError):
        raise CheckFailed("Server-mode response was not ClipCascade JSON. Check SSO/proxy interception.") from None
    if mode not in ("P2S", "P2P"):
        raise CheckFailed("Server returned an unsupported mode.")
    endpoint = "/clipsocket" if mode == "P2S" else "/p2psignaling"
    parts = urlsplit(base_url)
    ws_url = urlunsplit(("wss" if parts.scheme == "https" else "ws", parts.netloc, endpoint, "", ""))
    # Select the cookies applicable to this exact endpoint, including Secure/path.
    prepared = session.prepare_request(requests.Request("GET", base_url + endpoint))
    options = {
        "timeout": 15,
        "cookie": prepared.headers.get("Cookie", ""),
        "origin": base_url,
        "redirect_limit": 0,
        "sslopt": {"cert_reqs": ssl.CERT_REQUIRED},
    }
    if ca_bundle:
        options["sslopt"]["ca_certs"] = ca_bundle
    if direct:
        options["http_no_proxy"] = ["*"]
    ws = websocket.create_connection(ws_url, **options)
    try:
        if ws.getstatus() != 101:
            status = ws.getstatus()
            ws.shutdown()
            raise CheckFailed(f"WebSocket handshake returned HTTP {status}; expected 101. Check session cookies and proxy/SSO redirects.")
        if mode == "P2S":
            ws.send(f"CONNECT\naccept-version:1.2\nhost:{parts.netloc}\nheart-beat:0,20000\n\n\x00")
            ready = ws.recv()
            if isinstance(ready, bytes):
                ready = ready.decode("utf-8")
            if not ready.startswith("CONNECTED\n"):
                raise CheckFailed("WebSocket upgraded, but the STOMP session did not connect. Check broker/server logs.")
        else:
            try:
                ready = json.loads(ws.recv())
            except (ValueError, TypeError):
                raise CheckFailed("WebSocket upgraded, but P2P signaling did not initialize.") from None
            if not isinstance(ready, dict) or ready.get("type") != "ASSIGNED_ID":
                raise CheckFailed("P2P signaling did not assign a peer ID. Check server connection limits.")
        print(f"PASS: HTTP 101 and {mode} protocol connected on {endpoint}.")
        # recv processes WebSocket ping/pong frames; keep checking until the deadline.
        deadline = time.monotonic() + hold_seconds
        while time.monotonic() < deadline:
            ws.settimeout(min(5, max(0.1, deadline - time.monotonic())))
            try:
                frame = ws.recv()
                if frame in ("", b""):
                    raise CheckFailed("WebSocket closed during the hold check. Inspect timeouts and session expiry.")
            except websocket.WebSocketTimeoutException:
                continue
        if hold_seconds:
            print(f"PASS: Connection stayed open for {hold_seconds:g} seconds.")
    finally:
        ws.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Public server origin, e.g. https://clipboard.example.com:8743")
    parser.add_argument("--username", required=True)
    parser.add_argument("--ca-bundle", help="PEM bundle for a private CA; certificate verification stays enabled")
    parser.add_argument("--direct", action="store_true", help="Bypass local HTTP(S) proxy environment variables")
    parser.add_argument("--hold-seconds", type=float, default=0, help="Keep the socket open to check idle disconnects")
    args = parser.parse_args()
    try:
        parts = urlsplit(args.url)
        if (parts.scheme not in ("http", "https") or not parts.hostname
                or parts.username or parts.password or parts.path not in ("", "/")
                or parts.query or parts.fragment):
            raise CheckFailed("Use only the server origin: scheme://hostname[:port], without a subpath or credentials.")
        base_url = args.url.rstrip("/")
        origin(base_url)  # Validate the port before asking for a password.
        if args.hold_seconds < 0:
            raise CheckFailed("--hold-seconds must be zero or positive.")
        if parts.scheme == "http":
            print("NOTE: HTTP sends the login digest and session cookie without TLS. Use only a trusted test network.")
        if not args.direct and any(os.environ.get(k) for k in (
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")):
            print("NOTE: Local proxy environment variables are set. Try --direct if only native clients fail.")
        with ClientSession(base_url) as session:
            session.verify = args.ca_bundle or True
            session.trust_env = not args.direct
            password = getpass.getpass("ClipCascade password (not saved): ")
            login(session, base_url, args.username, password)
            check_websocket(session, base_url, args.ca_bundle, args.direct, args.hold_seconds)
        print("PASS: Login and live server connection work. Test clipboard transfer between two devices next.")
        return 0
    except CheckFailed as error:
        print(f"FAIL: {error}", file=sys.stderr)
    except (requests.exceptions.SSLError, ssl.SSLError):
        print("FAIL: TLS verification failed. Check hostname/full certificate chain or supply --ca-bundle for your private CA.", file=sys.stderr)
    except websocket.WebSocketBadStatusException as error:
        print(f"FAIL: WebSocket handshake returned HTTP {error.status_code}; expected 101. Check endpoint, session, origins, and proxy upgrades.", file=sys.stderr)
    except (requests.RequestException, websocket.WebSocketException, OSError, ValueError):
        # Exception strings can contain Cookie/Set-Cookie headers. Keep output safe to share.
        print("FAIL: Network/connection error. Check DNS, ports, local proxy settings, TLS, and server/proxy logs.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
