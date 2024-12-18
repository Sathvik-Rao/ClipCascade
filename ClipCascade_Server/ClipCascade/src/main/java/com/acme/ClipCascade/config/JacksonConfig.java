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
        // double the size to account for base64 overhead
        int MAX_MESSAGE_SIZE = ((MAX_MESSAGE_SIZE_IN_MiB << 20) * 2) + 1048576; // bytes

        ObjectMapper objectMapper = new ObjectMapper();
        objectMapper.getFactory().setStreamReadConstraints(
                StreamReadConstraints.builder().maxStringLength(MAX_MESSAGE_SIZE).build());
        return objectMapper;
    }
}
