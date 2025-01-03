package com.acme.clipcascade.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ClipCascadeProperties {

    // Read the value of the environment variable CC_MAX_MESSAGE_SIZE_IN_MiB
    @Value("${CC_MAX_MESSAGE_SIZE_IN_MiB:1}") // Default value is 1 MiB if the variable is not set
    private int maxMessageSizeInMiB;

    // Read the value of the environment variable CC_ALLOWED_ORIGINS
    @Value("${CC_ALLOWED_ORIGINS:*}") // Default value is * if the variable is not set
    private String allowedOrigins;

    public int getMaxMessageSizeInMiB() {
        return maxMessageSizeInMiB;
    }

    public int getMaxMessageSizeInBytes() {
        return maxMessageSizeInMiB << 20; // Convert MiB to bytes
    }

    public int getOverheadMaxMessageSizeInBytes() {
        // Double the size to account for base64 overhead and add 1 MiB(Safety margin)
        return ((maxMessageSizeInMiB << 20) * 2) + 1048576;
    }

    public String getAllowedOrigins() {
        return allowedOrigins;
    }
}
