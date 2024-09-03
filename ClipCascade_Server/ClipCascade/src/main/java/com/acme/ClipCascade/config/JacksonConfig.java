package com.acme.ClipCascade.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.ObjectMapper;

@Configuration
public class JacksonConfig {
    @Value("${CC_MAX_MESSAGE_SIZE}")
    private int MAX_MESSAGE_SIZE_IN_MiB;

    // Increase the Maximum String(JSON) Length in Jackson
    @Bean
    public ObjectMapper objectMapper() {
        /*
         * Adding additional bytes to accept client overhead on encryption and base64
         * encoding:
         * example:
         * 1. Original Size: 29,000,000 bytes
         * 2. Encryption Overhead: 28 bytes (12 bytes for nonce/IV + 16 bytes for
         * authentication tag)
         * 3. Calculate the Base64 size = (ceil(29,000,000+12+16) / 3) * 4
         * So, the total size after AES-GCM encryption and Base64 encoding for a 29 MB
         * file is approximately 38.67 MB.
         */
        int MAX_MESSAGE_SIZE = ((((MAX_MESSAGE_SIZE_IN_MiB << 20) + 30) / 3) * 4) + 1000000; // bytes

        ObjectMapper objectMapper = new ObjectMapper();
        objectMapper.getFactory().setStreamReadConstraints(
                StreamReadConstraints.builder().maxStringLength(MAX_MESSAGE_SIZE).build());
        return objectMapper;
    }
}
