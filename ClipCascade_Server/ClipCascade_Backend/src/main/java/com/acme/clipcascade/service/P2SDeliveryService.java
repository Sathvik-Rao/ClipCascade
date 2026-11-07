package com.acme.clipcascade.service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.math.BigInteger;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessageType;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.simp.user.SimpUser;
import org.springframework.messaging.simp.user.SimpUserRegistry;
import org.springframework.stereotype.Service;
import org.springframework.context.event.EventListener;
import org.springframework.web.socket.messaging.SessionConnectEvent;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import com.acme.clipcascade.model.ClipboardData;

@Service
@ConditionalOnProperty(prefix = "app.p2p", name = "enabled", havingValue = "false", matchIfMissing = false)
public class P2SDeliveryService {
    public static final String NO_SELF_ECHO_HEADER = "x-clipcascade-no-self-echo";
    private static final String NO_SELF_ECHO_ATTRIBUTE = P2SDeliveryService.class.getName() + ".noSelfEcho";
    public static final String RECEIVE_LIMIT_HEADER = "x-clipcascade-receive-limit";
    private static final String RECEIVE_LIMIT_ATTRIBUTE = P2SDeliveryService.class.getName() + ".receiveLimit";
    private static final long MAX_SIZE = (1L << 53) - 1;
    private static final String DESTINATION = "/queue/cliptext";

    private final SimpMessagingTemplate messaging;
    private final SimpUserRegistry users;
    private final Map<String, Long> receiveLimits = new ConcurrentHashMap<>();

    public P2SDeliveryService(SimpMessagingTemplate messaging, SimpUserRegistry users) {
        this.messaging = messaging;
        this.users = users;
    }

    public static void recordCapabilities(StompHeaderAccessor headers) {
        if (headers.getCommand() == StompCommand.CONNECT || headers.getCommand() == StompCommand.STOMP) {
            Map<String, Object> attributes = headers.getSessionAttributes();
            if (attributes != null) {
                attributes.put(NO_SELF_ECHO_ATTRIBUTE,
                        "true".equals(headers.getFirstNativeHeader(NO_SELF_ECHO_HEADER)));
                attributes.remove(RECEIVE_LIMIT_ATTRIBUTE);
                String limit = headers.getFirstNativeHeader(RECEIVE_LIMIT_HEADER);
                if ("unlimited".equals(limit)) {
                    attributes.put(RECEIVE_LIMIT_ATTRIBUTE, -1L);
                } else if (limit != null && limit.matches("[0-9]{1,16}")) {
                    try {
                        long value = Long.parseLong(limit);
                        if (value <= MAX_SIZE) attributes.put(RECEIVE_LIMIT_ATTRIBUTE, value);
                    } catch (NumberFormatException ignored) {}
                }
            }
        }
    }

    @EventListener
    public void onConnect(SessionConnectEvent event) {
        var headers = SimpMessageHeaderAccessor.wrap(event.getMessage());
        Map<String, Object> attributes = headers.getSessionAttributes();
        if (headers.getSessionId() != null && attributes != null
                && attributes.get(RECEIVE_LIMIT_ATTRIBUTE) instanceof Long limit) {
            receiveLimits.put(headers.getSessionId(), limit);
        }
    }

    @EventListener
    public void onDisconnect(SessionDisconnectEvent event) {
        receiveLimits.remove(event.getSessionId());
    }

    private Long contentSize(ClipboardData data) {
        Object value = data.getMetadata() == null ? null : data.getMetadata().get("contentSizeBytes");
        if (!(value instanceof Byte || value instanceof Short || value instanceof Integer
                || value instanceof Long || value instanceof BigInteger)) return null;
        try {
            long size = new BigInteger(value.toString()).longValueExact();
            return size >= 0 && size <= MAX_SIZE ? size : null;
        } catch (ArithmeticException ignored) {
            return null;
        }
    }

    public void send(String username, ClipboardData data, SimpMessageHeaderAccessor source) {
        Map<String, Object> attributes = source.getSessionAttributes();
        String sender = source.getSessionId();
        boolean noEcho = sender != null && attributes != null
                && Boolean.TRUE.equals(attributes.get(NO_SELF_ECHO_ATTRIBUTE));
        Long size = contentSize(data);
        SimpUser user = users.getUser(username);
        boolean needsFiltering = size != null && user != null && user.getSessions().stream().anyMatch(session -> {
            Long limit = receiveLimits.get(session.getId());
            return !session.getId().equals(sender) && limit != null && limit >= 0 && size > limit;
        });
        if (!noEcho && !needsFiltering) {
            // Preserve the exact legacy broadcast when no recipient needs
            // filtering. Old mobile clients require their own echo to unlock.
            messaging.convertAndSendToUser(username, DESTINATION, data);
            return;
        }
        if (user == null) return;
        for (var session : user.getSessions()) {
            String recipient = session.getId();
            if (noEcho && recipient.equals(sender)) continue;
            Long limit = receiveLimits.get(recipient);
            // A legacy sender must still receive its unlocking echo. Limits
            // affect other recipients, never the acknowledgment of that send.
            if (!recipient.equals(sender) && size != null && limit != null && limit >= 0 && size > limit) continue;
            SimpMessageHeaderAccessor target = SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
            target.setSessionId(recipient);
            target.setLeaveMutable(true);
            // Target the session itself. If it disconnects during routing,
            // Spring must not fall back to a user-wide broadcast.
            messaging.convertAndSendToUser(recipient, DESTINATION, data, target.getMessageHeaders());
        }
    }
}
