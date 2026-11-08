package com.acme.clipcascade.controller;

import java.nio.ByteBuffer;
import java.security.Principal;
import java.util.Map;

import com.acme.clipcascade.service.P2SDeliveryService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Opaque encrypted routing. The relay never holds a clipboard encryption key. */
@RestController
@ConditionalOnProperty(prefix = "app.p2p", name = "enabled", havingValue = "false")
public class BinaryClipboardController {
    private final P2SDeliveryService delivery;
    private final ObjectMapper mapper;

    public BinaryClipboardController(P2SDeliveryService delivery, ObjectMapper mapper) {
        this.delivery = delivery;
        this.mapper = mapper;
    }

    @GetMapping("/clipbinary/recipients")
    public org.springframework.http.ResponseEntity<Map<String, Object>> recipients(Principal principal) {
        return org.springframework.http.ResponseEntity.ok()
                .cacheControl(org.springframework.http.CacheControl.noStore())
                .body(delivery.recipients(principal.getName()));
    }

    @MessageMapping("/clipbinary")
    public void send(Principal principal, byte[] data, SimpMessageHeaderAccessor source) throws Exception {
        if (data.length < 8 || ByteBuffer.wrap(data).getInt() != 0x43434231)
            throw new IllegalArgumentException("Invalid binary clipboard frame");
        int length = ByteBuffer.wrap(data, 4, 4).getInt();
        if (length < 0 || length > 65536 || length > data.length - 8)
            throw new IllegalArgumentException("Invalid binary clipboard header");
        var header = mapper.readTree(data, 8, length);
        if (!header.isObject() || !header.path("encrypted").isBoolean()
                || !java.util.Set.of("text", "image", "files").contains(header.path("type").asText()))
            throw new IllegalArgumentException("Invalid binary clipboard envelope");
        var metadata = header.path("metadata");
        if (metadata.path("isFragmented").asBoolean(false))
            throw new IllegalArgumentException("Fragmented relay frame");
        var size = metadata.path("contentSizeBytes");
        if (!size.isIntegralNumber() || !size.canConvertToLong() || size.longValue() < 0
                || size.longValue() > (1L << 53) - 1)
            throw new IllegalArgumentException("Invalid binary clipboard size");
        delivery.sendBinary(principal.getName(), data, size.longValue(), source);
    }
}
