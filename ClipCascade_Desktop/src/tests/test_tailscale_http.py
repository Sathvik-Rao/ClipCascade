"""Tailscale / private-mesh HTTP policy for desktop server URLs."""

import os
import sys
import unittest
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1]
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from core.config import Config  # noqa: E402


class TailscaleHttpPolicyTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("CLIPCASCADE_ALLOW_INSECURE_HTTP", None)
        os.environ.pop("CLIPCASCADE_ALLOW_PRIVATE_HTTP", None)

    def tearDown(self):
        os.environ.pop("CLIPCASCADE_ALLOW_INSECURE_HTTP", None)
        os.environ.pop("CLIPCASCADE_ALLOW_PRIVATE_HTTP", None)

    def test_allows_tailscale_cgnat_http(self):
        Config.validate_server_url("http://100.64.1.2:8080")
        Config.validate_server_url("http://100.127.0.1:8080")

    def test_rejects_public_http_with_leading_whitespace(self):
        """
        The URL is normalised before the scheme is inspected. Otherwise
        urlparse(" http://...") reports an empty scheme and the guard never
        fires.
        """
        with self.assertRaises(ValueError):
            Config.validate_server_url(" http://evil.example.com")
        with self.assertRaises(ValueError):
            Config.validate_server_url("\thttp://evil.example.com")

    def test_rejects_ipv4_mapped_public_http(self):
        """
        Python reports ::ffff:8.8.8.8 as is_private, because ::ffff:0:0/96 is
        in its IPv6 private list. The embedded IPv4 address is what counts.
        """
        with self.assertRaises(ValueError):
            Config.validate_server_url("http://[::ffff:8.8.8.8]")
        self.assertFalse(Config._is_private_or_mesh_host("::ffff:8.8.8.8"))
        self.assertTrue(Config._is_private_or_mesh_host("::ffff:100.64.0.1"))
        self.assertTrue(Config._is_private_or_mesh_host("::ffff:192.168.1.1"))

    def test_rejects_the_public_ts_net_apex(self):
        """
        "ts.net" is Tailscale's own public domain, not a mesh host. Only
        MagicDNS names under it are private. Mobile asserts the same thing.
        """
        self.assertFalse(Config._is_private_or_mesh_host("ts.net"))
        self.assertFalse(Config._is_private_or_mesh_host("evilts.net"))
        self.assertFalse(Config._is_private_or_mesh_host("box.ts.net.evil.com"))
        with self.assertRaises(ValueError):
            Config.validate_server_url("http://ts.net:8080")

    def test_allows_magicdns_http(self):
        Config.validate_server_url("http://clipcascade.tail-abc123.ts.net:8080")
        Config.validate_server_url("http://my-nas.ts.net")

    def test_allows_rfc1918_and_loopback(self):
        Config.validate_server_url("http://192.168.1.10:8080")
        Config.validate_server_url("http://10.0.0.5:8080")
        Config.validate_server_url("http://172.16.0.1:8080")
        Config.validate_server_url("http://127.0.0.1:8080")
        Config.validate_server_url("http://localhost:8080")

    def test_rejects_public_http(self):
        with self.assertRaises(ValueError):
            Config.validate_server_url("http://example.com:8080")
        with self.assertRaises(ValueError):
            Config.validate_server_url("http://8.8.8.8:8080")

    def test_allows_public_https(self):
        Config.validate_server_url("https://example.com")
        Config.validate_server_url("https://clipcascade.example.com:8443")

    def test_strict_mode_disables_private_http(self):
        os.environ["CLIPCASCADE_ALLOW_PRIVATE_HTTP"] = "false"
        with self.assertRaises(ValueError):
            Config.validate_server_url("http://100.64.1.2:8080")
        Config.validate_server_url("http://localhost:8080")

    def test_override_allows_public_http(self):
        os.environ["CLIPCASCADE_ALLOW_INSECURE_HTTP"] = "true"
        Config.validate_server_url("http://example.com:8080")

    def test_is_private_or_mesh_host_helpers(self):
        self.assertTrue(Config._is_private_or_mesh_host("100.100.50.1"))
        self.assertTrue(Config._is_private_or_mesh_host("foo.bar.ts.net"))
        self.assertFalse(Config._is_private_or_mesh_host("evil.example.com"))


if __name__ == "__main__":
    unittest.main()
