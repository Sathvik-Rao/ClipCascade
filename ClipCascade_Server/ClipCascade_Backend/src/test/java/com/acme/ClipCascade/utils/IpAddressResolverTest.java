package com.acme.ClipCascade.utils;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import com.acme.clipcascade.utils.IpAddressResolver;

/**
 * The resolved address keys per-IP brute-force accounting, so a client must
 * never be able to choose it.
 *
 * Note these run without CC_TRUSTED_PROXY_CIDRS set, which is the default and
 * the shipped posture: forwarded headers are ignored outright.
 */
class IpAddressResolverTest {

    private static void request(String remoteAddr, String... headerPairs) {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setRemoteAddr(remoteAddr);
        for (int i = 0; i + 1 < headerPairs.length; i += 2) {
            req.addHeader(headerPairs[i], headerPairs[i + 1]);
        }
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(req));
    }

    @AfterEach
    void clear() {
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void untrustedPeerCannotSpoofItsAddress() {
        request("203.0.113.9", "X-Forwarded-For", "1.2.3.4");
        assertEquals("203.0.113.9", IpAddressResolver.getUserIpAddress());
    }

    @Test
    void secondaryHeadersAreNeverConsulted() {
        // A proxy overwrites X-Forwarded-For but leaves these alone, so honouring
        // them would hand the client back control of its recorded address.
        request("203.0.113.9",
                "Proxy-Client-IP", "9.9.9.9",
                "WL-Proxy-Client-IP", "9.9.9.9",
                "HTTP_CLIENT_IP", "9.9.9.9",
                "HTTP_VIA", "1.1 vegur");
        assertEquals("203.0.113.9", IpAddressResolver.getUserIpAddress());
    }

    @Test
    void hostnamesInTheHeaderAreIgnored() {
        // Must not reach InetAddress, or an inbound header becomes a DNS lookup.
        request("203.0.113.9", "X-Forwarded-For", "example.com");
        assertEquals("203.0.113.9", IpAddressResolver.getUserIpAddress());
    }

    @Test
    void missingRequestContextIsHandled() {
        RequestContextHolder.resetRequestAttributes();
        assertEquals("0.0.0.0", IpAddressResolver.getUserIpAddress());
    }

    @Test
    void ipLiteralDetectionRejectsHostnamesAndJunk() {
        assertTrue(IpAddressResolver.isIpLiteral("10.0.0.5"));
        assertTrue(IpAddressResolver.isIpLiteral("203.0.113.9"));
        assertTrue(IpAddressResolver.isIpLiteral("::1"));
        assertTrue(IpAddressResolver.isIpLiteral("[fd7a:115c:a1e0::1]"));

        assertFalse(IpAddressResolver.isIpLiteral("example.com"));
        assertFalse(IpAddressResolver.isIpLiteral("1.1 vegur"));
        assertFalse(IpAddressResolver.isIpLiteral("999.1.1.1"));
        assertFalse(IpAddressResolver.isIpLiteral("unknown"));
        assertFalse(IpAddressResolver.isIpLiteral(""));
        assertFalse(IpAddressResolver.isIpLiteral(null));

        // Junk IPv6 previously passed a permissive character-class match and
        // then keyed its own brute-force bucket.
        assertFalse(IpAddressResolver.isIpLiteral(":"));
        assertFalse(IpAddressResolver.isIpLiteral(":::"));
        assertFalse(IpAddressResolver.isIpLiteral("::::"));
        assertFalse(IpAddressResolver.isIpLiteral("1::2::3"));

        // Leading zeros are ambiguous (decimal here, octal elsewhere) and would
        // let one host occupy two buckets.
        assertFalse(IpAddressResolver.isIpLiteral("203.0.113.050"));
        assertFalse(IpAddressResolver.isIpLiteral("010.0.0.1"));
    }

    // --- The trusted-proxy path. Previously untested: every case above runs
    // --- with CC_TRUSTED_PROXY_CIDRS unset, i.e. the path where the header is
    // --- ignored outright, so none of them could catch the bugs below.

    private static MockHttpServletRequest req(String remoteAddr, String... headerPairs) {
        MockHttpServletRequest r = new MockHttpServletRequest();
        r.setRemoteAddr(remoteAddr);
        for (int i = 0; i + 1 < headerPairs.length; i += 2) {
            r.addHeader(headerPairs[i], headerPairs[i + 1]);
        }
        return r;
    }

    private static String resolveTrusted(MockHttpServletRequest r) {
        return IpAddressResolver.resolve(r, "10.0.0.0/8", "X-Forwarded-For");
    }

    @Test
    void trustedProxyChainYieldsTheRealClient() {
        assertEquals("203.0.113.9",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "203.0.113.9")));
        // A client-supplied prefix must not win: proxies append, so the client's
        // own value ends up left-most.
        assertEquals("203.0.113.9",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "1.2.3.4, 203.0.113.9")));
    }

    @Test
    void duplicateHeaderLinesCannotBeUsedToWin() {
        // A client sends its own line; the proxy appends a second. getHeader()
        // returns only the FIRST — the client's — so all values must be joined.
        MockHttpServletRequest r = req("10.0.0.1");
        r.addHeader("X-Forwarded-For", "1.2.3.4");
        r.addHeader("X-Forwarded-For", "203.0.113.9");
        assertEquals("203.0.113.9", resolveTrusted(r));
    }

    @Test
    void rightmostHopWithAPortResolvesToItsAddress() {
        // Some proxies append "ip:port". The address is legitimate, so use it —
        // the point is that the client-supplied left-most "8.8.8.8" must never
        // be what comes back.
        assertEquals("203.0.113.9",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "8.8.8.8, 203.0.113.9:54321")));
    }

    @Test
    void unusableRightmostHopFailsClosedToTheSocketPeer() {
        // Skipping junk and walking further left would step into client-written
        // entries, so stop instead. "8.8.8.8" is the client's and must not win.
        assertEquals("10.0.0.1",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "8.8.8.8, :::")));
        assertEquals("10.0.0.1",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "8.8.8.8, example.com")));
        assertEquals("10.0.0.1",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "8.8.8.8, unknown")));
        assertEquals("10.0.0.1",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "8.8.8.8, 203.0.113.050")));
    }

    @Test
    void spellingVariantsCollapseToOneLockoutKey() {
        // Otherwise an attacker rotates spellings to spread failures across
        // buckets and never trips the limit.
        assertEquals("203.0.113.9",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "203.0.113.9")));
        assertEquals("10.0.0.1",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "203.0.113.050")));
        assertEquals("0:0:0:0:0:0:0:1",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "::1")));
        assertEquals("0:0:0:0:0:0:0:1",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "[::1]")));
    }

    @Test
    void allHopsTrustedFallsBackToTheSocketPeer() {
        assertEquals("10.0.0.1",
                resolveTrusted(req("10.0.0.1", "X-Forwarded-For", "10.0.0.7, 10.0.0.8")));
    }

    @Test
    void headerIsIgnoredEntirelyWhenNoProxyIsTrusted() {
        assertEquals("10.0.0.1",
                IpAddressResolver.resolve(
                        req("10.0.0.1", "X-Forwarded-For", "1.2.3.4"), null, "X-Forwarded-For"));
        assertEquals("10.0.0.1",
                IpAddressResolver.resolve(
                        req("10.0.0.1", "X-Forwarded-For", "1.2.3.4"), "  ", "X-Forwarded-For"));
    }
}
