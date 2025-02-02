package com.acme.clipcascade.utils;

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
        for (String header : IpResolverConstants.IP_HEADER_CANDIDATES) {
            String ipList = request.getHeader(header);
            if (ipList != null
                    && !ipList.isEmpty()
                    && !IpResolverConstants.UNKNOWN.equalsIgnoreCase(ipList)) {

                return ipList.split(",")[0].trim();
            }
        }

        return request.getRemoteAddr();
    }
}
