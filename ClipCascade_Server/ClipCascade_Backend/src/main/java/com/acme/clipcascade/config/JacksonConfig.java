package com.acme.clipcascade.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.ObjectMapper;

@Configuration
public class JacksonConfig {
    private final ClipCascadeProperties clipCascadeProperties;

    public JacksonConfig(ClipCascadeProperties clipCascadeProperties) {
        this.clipCascadeProperties = clipCascadeProperties;
    }

    // Increase the Maximum String(JSON) Length in Jackson
    @Bean
    public ObjectMapper objectMapper() {
        ObjectMapper objectMapper = new ObjectMapper();
        objectMapper.getFactory().setStreamReadConstraints(
                StreamReadConstraints
                        .builder()
                        .maxStringLength(
                                clipCascadeProperties.getOverheadMaxMessageSizeInBytes())
                        .build());
        return objectMapper;
    }
}
