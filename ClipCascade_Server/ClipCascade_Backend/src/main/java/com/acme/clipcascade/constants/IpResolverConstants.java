package com.acme.clipcascade.constants;

public class IpResolverConstants {

    // IP header candidates
    public static final String[] IP_HEADER_CANDIDATES = {
            "X-Forwarded-For",
            "Proxy-Client-IP",
            "WL-Proxy-Client-IP",
            "HTTP_X_FORWARDED_FOR",
            "HTTP_X_FORWARDED",
            "HTTP_X_CLUSTER_CLIENT_IP",
            "HTTP_CLIENT_IP",
            "HTTP_FORWARDED_FOR",
            "HTTP_FORWARDED",
            "HTTP_VIA",
            "REMOTE_ADDR"
    };

    // Unknown IP
    public static final String UNKNOWN = "unknown";

    private IpResolverConstants() {
        // private constructor to prevent instantiation
    }
}
