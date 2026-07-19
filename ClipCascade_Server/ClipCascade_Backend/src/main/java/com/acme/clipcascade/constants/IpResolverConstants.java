package com.acme.clipcascade.constants;

public class IpResolverConstants {

    /**
     * The single forwarding header consulted, and only when the request came
     * from a trusted proxy.
     *
     * This used to be a list that also included Proxy-Client-IP,
     * WL-Proxy-Client-IP, HTTP_VIA and friends. Trying them in turn is unsafe:
     * a real proxy sets and overwrites X-Forwarded-For but does not touch the
     * others, so a client could simply send one of them and choose the address
     * that brute-force accounting is keyed on. Override only if your proxy uses
     * a different header, and make sure that proxy overwrites it on every
     * request.
     */
    public static final String DEFAULT_FORWARDED_HEADER = "X-Forwarded-For";

    // Unknown IP
    public static final String UNKNOWN = "unknown";

    private IpResolverConstants() {
        // private constructor to prevent instantiation
    }
}
