package com.acme.ClipCascade.config;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import com.acme.clipcascade.config.ClipCascadeProperties;

class ClipCascadePropertiesTest {

    private static ClipCascadeProperties withOrigins(String origins) {
        ClipCascadeProperties properties = new ClipCascadeProperties();
        ReflectionTestUtils.setField(properties, "allowedOrigins", origins);
        // Keep the unrelated H2 guard quiet; this test is about origins.
        ReflectionTestUtils.setField(properties, "serverDbUrl", "jdbc:postgresql://db/clipcascade");
        return properties;
    }

    private static void validate(ClipCascadeProperties properties) {
        ReflectionTestUtils.invokeMethod(properties, "validateRequiredSecrets");
    }

    @Test
    void wildcardOriginFailsStartup() {
        // A wildcard is applied verbatim to both WebSocket endpoints, so any
        // site could open an authenticated socket with the visitor's cookie and
        // read their clipboard. It has to fail loudly, not be silently narrowed.
        IllegalStateException error = assertThrows(
                IllegalStateException.class,
                () -> validate(withOrigins("*")));
        assertTrue(error.getMessage().contains("CC_ALLOWED_ORIGINS"));
    }

    @Test
    void wildcardMixedWithExactOriginsAlsoFailsStartup() {
        assertThrows(
                IllegalStateException.class,
                () -> validate(withOrigins("http://100.64.0.1:8080, *")));
    }

    @Test
    void exactOriginsAreAccepted() {
        ClipCascadeProperties properties =
                withOrigins("http://100.64.0.1:8080, https://box.example.ts.net");
        assertDoesNotThrow(() -> validate(properties));
        assertArrayEquals(
                new String[] {"http://100.64.0.1:8080", "https://box.example.ts.net"},
                properties.getAllowedOriginsArray());
    }

    @Test
    void wildcardIsDroppedFromTheOriginsArray() {
        // Defence in depth for any caller that skips validateRequiredSecrets.
        assertArrayEquals(
                new String[] {"http://100.64.0.1:8080"},
                withOrigins("http://100.64.0.1:8080,*").getAllowedOriginsArray());
    }

    @Test
    void blankOriginsFallBackToLocalhost() {
        assertArrayEquals(
                new String[] {"http://localhost:8080"},
                withOrigins("").getAllowedOriginsArray());
    }
}
