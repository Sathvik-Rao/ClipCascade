package com.acme.clipcascade.utils;

import java.math.BigInteger;
import java.net.InetAddress;

import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import com.acme.clipcascade.constants.IpResolverConstants;

import jakarta.servlet.http.HttpServletRequest;

public class IpAddressResolver {

    public static String getUserIpAddress() {

        Object requestAttributes = RequestContextHolder.getRequestAttributes();

        if (requestAttributes == null) {
            return "0.0.0.0";
        }

        HttpServletRequest request = ((ServletRequestAttributes) requestAttributes).getRequest();
        return resolve(request, System.getenv("CC_TRUSTED_PROXY_CIDRS"), forwardedHeader());
    }

    /**
     * Pure resolution, with configuration passed in so it can be tested.
     *
     * The env is read once at the public entry point above; everything below
     * this line is a function of its arguments.
     */
    public static String resolve(
            HttpServletRequest request, String trustedCidrs, String headerName) {
        String remoteAddress = request.getRemoteAddr();

        // Forwarded headers are only meaningful when the peer that set them is a
        // proxy we trust. Otherwise any client could name its own IP and defeat
        // the per-IP brute-force limits that consume this value.
        if (!isTrustedProxy(remoteAddress, trustedCidrs)) {
            return remoteAddress;
        }

        String ipList = joinedForwardedHeader(request, headerName);
        if (ipList != null && !ipList.isEmpty()) {
            String candidate = rightmostUntrustedHop(ipList, trustedCidrs);
            if (candidate != null) {
                return candidate;
            }
        }

        // Header absent, or every hop in it was itself a trusted proxy. Fall
        // back to the socket peer rather than consulting another header: any
        // other header is one the proxy does not overwrite, so it would hand
        // the client control of this value again.
        return remoteAddress;
    }

    /**
     * All values of the forwarding header, joined left-to-right.
     *
     * A client can send its own header line, and a proxy that appends rather
     * than replaces produces two separate lines. getHeader() returns only the
     * FIRST, which is the client's — so reading it alone would hand the client
     * the value again, defeating the point of walking right-to-left.
     */
    private static String joinedForwardedHeader(HttpServletRequest request, String headerName) {
        java.util.Enumeration<String> values = request.getHeaders(headerName);
        if (values == null) {
            return null;
        }
        StringBuilder joined = new StringBuilder();
        while (values.hasMoreElements()) {
            String value = values.nextElement();
            if (value == null || value.isBlank()) {
                continue;
            }
            if (joined.length() > 0) {
                joined.append(',');
            }
            joined.append(value);
        }
        return joined.toString();
    }

    private static String forwardedHeader() {
        String configured = System.getenv("CC_FORWARDED_HEADER");
        if (configured == null || configured.isBlank()) {
            return IpResolverConstants.DEFAULT_FORWARDED_HEADER;
        }
        return configured.trim();
    }

    /**
     * The right-most hop that is not itself a trusted proxy, canonicalised.
     *
     * Proxies append to X-Forwarded-For rather than replacing it (nginx's
     * $proxy_add_x_forwarded_for, and every comparable default), so a client
     * that sends "X-Forwarded-For: 9.9.9.9" produces "9.9.9.9, &lt;real client&gt;".
     * Taking the left-most entry would return the attacker's own chosen value;
     * everything to the right of the first untrusted hop was written by
     * infrastructure we trust, so that hop is the real client.
     *
     * Fails closed: if the right-most hop is not a usable IP literal we return
     * null (so the caller uses the socket peer) rather than walking further
     * left. Skipping junk and continuing would step over infrastructure-written
     * entries into client-written ones, which is how "8.8.8.8, 203.0.113.9:54321"
     * ended up resolving to the client's own value.
     */
    private static String rightmostUntrustedHop(String ipList, String trustedCidrs) {
        String[] hops = ipList.split(",");
        for (int i = hops.length - 1; i >= 0; i--) {
            String hop = hops[i].trim();
            if (hop.isEmpty()) {
                continue;
            }
            String canonical = canonicalIp(hop);
            if (canonical == null) {
                // Junk, a hostname, or "unknown": stop rather than skip.
                return null;
            }
            if (!isTrustedProxy(canonical, trustedCidrs)) {
                return canonical;
            }
        }
        return null;
    }

    /**
     * Normalise an IP literal to one canonical string, or null if it is not one.
     *
     * Brute-force accounting keys on this value, so two spellings of the same
     * host must not produce two buckets: "203.0.113.050" and "203.0.113.50",
     * or "::1" and "[::1]", would otherwise be separate counters and an
     * attacker could rotate spellings to stay under the limit. Also strips an
     * optional :port, which some proxies append, and refuses hostnames so that
     * an inbound header can never trigger a DNS lookup on the request path.
     */
    static String canonicalIp(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String candidate = value.trim();
        if (IpResolverConstants.UNKNOWN.equalsIgnoreCase(candidate)) {
            return null;
        }

        // [::1]:8080 or [::1]
        if (candidate.startsWith("[")) {
            int close = candidate.indexOf(']');
            if (close < 0) {
                return null;
            }
            candidate = candidate.substring(1, close);
        } else {
            // IPv4 with a port; a bare IPv6 has many colons, so only strip when
            // there is exactly one.
            int colon = candidate.indexOf(':');
            if (colon >= 0 && candidate.indexOf(':', colon + 1) < 0) {
                candidate = candidate.substring(0, colon);
            }
        }
        // Drop an IPv6 zone index (fe80::1%eth0) — it is host-local and not
        // meaningful as an identity here.
        int zone = candidate.indexOf('%');
        if (zone >= 0) {
            candidate = candidate.substring(0, zone);
        }
        if (candidate.isEmpty() || !isIpLiteral(candidate)) {
            return null;
        }

        try {
            // Safe: isIpLiteral has already excluded anything that would resolve.
            return InetAddress.getByName(candidate).getHostAddress();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * True for a bare IPv4 or IPv6 literal (optionally bracketed).
     *
     * Deliberately strict: it gates every value that reaches InetAddress, so a
     * hostname never gets that far.
     */
    public static boolean isIpLiteral(String value) {
        if (value == null || value.isBlank()) {
            return false;
        }
        String candidate = value.trim();
        if (candidate.startsWith("[") && candidate.endsWith("]") && candidate.length() > 2) {
            candidate = candidate.substring(1, candidate.length() - 1);
        }
        if (candidate.indexOf(':') >= 0) {
            // At most one "::", and every group a valid hextet. A permissive
            // character-class match accepts junk like ":::" — which still keys
            // a distinct brute-force bucket, so it has to be refused.
            if (candidate.indexOf("::") != candidate.lastIndexOf("::")) {
                return false;
            }
            if (candidate.equals(":") || candidate.endsWith(":") && !candidate.endsWith("::")) {
                return false;
            }
            String[] groups = candidate.split(":", -1);
            if (groups.length > 8) {
                return false;
            }
            int emptyGroups = 0;
            boolean sawHextet = false;
            for (int i = 0; i < groups.length; i++) {
                String group = groups[i];
                if (group.isEmpty()) {
                    emptyGroups++;
                    continue;
                }
                // A trailing IPv4 form (::ffff:1.2.3.4) is legal in the last group.
                if (i == groups.length - 1 && group.indexOf('.') >= 0) {
                    if (!isDottedQuad(group)) {
                        return false;
                    }
                    sawHextet = true;
                    continue;
                }
                if (!group.matches("[0-9A-Fa-f]{1,4}")) {
                    return false;
                }
                sawHextet = true;
            }
            // "::" produces two empties at most; ":::" produces more.
            return sawHextet && emptyGroups <= 2;
        }

        return isDottedQuad(candidate);
    }

    /**
     * Strict dotted-quad: no leading zeros.
     *
     * "203.0.113.050" and "203.0.113.50" are the same host, but Java reads the
     * leading zero as decimal while other stacks read it as octal. Accepting
     * both spellings would let one client occupy two brute-force buckets, so
     * the ambiguous form is refused outright.
     */
    private static boolean isDottedQuad(String candidate) {
        String[] octets = candidate.split("\\.", -1);
        if (octets.length != 4) {
            return false;
        }
        for (String octet : octets) {
            if (!octet.matches("(0|[1-9]\\d{0,2})")) {
                return false;
            }
            if (Integer.parseInt(octet) > 255) {
                return false;
            }
        }
        return true;
    }

    private static boolean isTrustedProxy(String remoteAddress, String trustedCidrs) {
        if (trustedCidrs == null || trustedCidrs.isBlank()) {
            return false;
        }

        for (String cidr : trustedCidrs.split(",")) {
            if (addressMatchesCidr(remoteAddress, cidr.trim())) {
                return true;
            }
        }
        return false;
    }

    private static boolean addressMatchesCidr(String address, String cidr) {
        if (address == null || address.isBlank() || cidr == null || cidr.isBlank()) {
            return false;
        }
        // Guard InetAddress against anything that would trigger a DNS lookup.
        if (!isIpLiteral(address)) {
            return false;
        }

        try {
            if (!cidr.contains("/")) {
                return InetAddress.getByName(address).equals(InetAddress.getByName(cidr));
            }

            String[] parts = cidr.split("/", 2);
            InetAddress ip = InetAddress.getByName(address);
            InetAddress network = InetAddress.getByName(parts[0]);
            int prefixLength = Integer.parseInt(parts[1]);

            byte[] ipBytes = ip.getAddress();
            byte[] networkBytes = network.getAddress();
            if (ipBytes.length != networkBytes.length || prefixLength < 0 || prefixLength > ipBytes.length * 8) {
                return false;
            }

            BigInteger ipValue = new BigInteger(1, ipBytes);
            BigInteger networkValue = new BigInteger(1, networkBytes);
            int shift = ipBytes.length * 8 - prefixLength;
            return ipValue.shiftRight(shift).equals(networkValue.shiftRight(shift));
        } catch (Exception e) {
            return false;
        }
    }
}
