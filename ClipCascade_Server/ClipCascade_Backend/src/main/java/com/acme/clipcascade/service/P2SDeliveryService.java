package com.acme.clipcascade.service;

import java.util.Map;
import java.util.List;
import java.util.Set;
import java.util.Arrays;
import java.util.stream.Collectors;
import org.springframework.util.MimeTypeUtils;
import java.util.HashSet;
import java.util.UUID;
import org.springframework.scheduling.annotation.Scheduled;
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
    public static final String UPDATES_HEADER = "x-clipcascade-recipient-updates";
    private static final String CLOSED_ATTRIBUTE = P2SDeliveryService.class.getName() + ".closed";
    private static final String UPDATES_ATTRIBUTE = P2SDeliveryService.class.getName() + ".updates";
    private record Subscriber(String username, boolean binary, boolean updates, Set<String> subscriptions) {}
    private final Map<String, Subscriber> subscribers = new java.util.HashMap<>();
    private final String updatesEpoch = UUID.randomUUID().toString();
    private long updatesRevision;
    public static final String BINARY_HEADER = "x-clipcascade-binary";
    public static final String RECIPIENTS_HEADER = "x-clipcascade-recipients";
    private static final String BINARY_ATTRIBUTE = P2SDeliveryService.class.getName() + ".binary";
    private final Set<String> binarySessions = ConcurrentHashMap.newKeySet();
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
                attributes.put(UPDATES_ATTRIBUTE, "1".equals(headers.getFirstNativeHeader(UPDATES_HEADER)));
                attributes.put(BINARY_ATTRIBUTE, "ccb1".equals(headers.getFirstNativeHeader(BINARY_HEADER)));
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
    public synchronized void onConnect(SessionConnectEvent event) {
        var headers = SimpMessageHeaderAccessor.wrap(event.getMessage());
        Map<String, Object> attributes = headers.getSessionAttributes();
        if (headers.getSessionId() != null && attributes != null
                && !Boolean.TRUE.equals(attributes.get(CLOSED_ATTRIBUTE))
                && attributes.get(RECEIVE_LIMIT_ATTRIBUTE) instanceof Long limit) {
            receiveLimits.put(headers.getSessionId(), limit);
        }
    }

    @EventListener
    public synchronized void onDisconnect(SessionDisconnectEvent event) {
        var attributes = SimpMessageHeaderAccessor.wrap(event.getMessage()).getSessionAttributes();
        // The same attribute map is retained by inbound tasks queued before socket shutdown.
        if (attributes != null) attributes.put(CLOSED_ATTRIBUTE, true);
        receiveLimits.remove(event.getSessionId());
        binarySessions.remove(event.getSessionId());
        Subscriber removed = subscribers.remove(event.getSessionId());
        if (removed != null) pushRecipients(removed.username());
    }

    /** Called after UserDestinationMessageHandler has installed the translated subscription.
     * SessionSubscribeEvent alone can precede broker registration and lose the initial update.
     */
    public synchronized void subscriptionReady(SimpMessageHeaderAccessor headers) {
        String session = headers.getSessionId();
        String subscription = headers.getSubscriptionId();
        if (!"/user/queue/cliptext".equals(headers.getDestination()) || session == null
                || subscription == null || headers.getUser() == null) return;
        Map<String, Object> attributes = headers.getSessionAttributes();
        if (attributes != null && Boolean.TRUE.equals(attributes.get(CLOSED_ATTRIBUTE))) return;
        boolean binary = attributes != null && Boolean.TRUE.equals(attributes.get(BINARY_ATTRIBUTE));
        boolean updates = attributes != null && Boolean.TRUE.equals(attributes.get(UPDATES_ATTRIBUTE));
        if (binary) binarySessions.add(session);
        Subscriber state = subscribers.get(session);
        if (state == null) {
            state = new Subscriber(headers.getUser().getName(), binary, updates, new HashSet<>());
            subscribers.put(session, state);
        }
        if (state.subscriptions().add(subscription)) pushRecipients(state.username());
    }

    public synchronized void subscriptionRemoved(SimpMessageHeaderAccessor headers) {
        Subscriber state = subscribers.get(headers.getSessionId());
        if (state == null || !state.subscriptions().remove(headers.getSubscriptionId())) return;
        if (!state.subscriptions().isEmpty()) return;
        subscribers.remove(headers.getSessionId());
        binarySessions.remove(headers.getSessionId());
        pushRecipients(state.username());
    }

    /** Full snapshots also repair dropped updates; clipboard traffic is never required. */
    @Scheduled(fixedDelay = 20_000, initialDelay = 20_000)
    public synchronized void refreshRecipientUpdates() {
        subscribers.values().stream().filter(Subscriber::updates).map(Subscriber::username)
                .collect(Collectors.toSet()).forEach(this::pushRecipients);
    }

    private void pushRecipients(String username) {
        List<Map<String, Object>> peers = subscribers.entrySet().stream()
                .filter(entry -> entry.getValue().username().equals(username))
                .limit(257) // Oversized snapshots invalidate the cache and use legacy fallback.
                .map(entry -> Map.<String, Object>of("id", entry.getKey(), "binary", entry.getValue().binary()))
                .toList();
        Map<String, Object> snapshot = Map.of("_cc_control", "relay-recipients", "version", 1,
                "epoch", updatesEpoch, "revision", ++updatesRevision, "format", "ccb1", "recipients", peers);
        for (var entry : subscribers.entrySet()) {
            Subscriber recipient = entry.getValue();
            // Sending control data requires explicit opt-in, even for binary-capable clients.
            if (!recipient.updates() || !recipient.username().equals(username)) continue;
            var target = SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
            target.setSessionId(entry.getKey());
            target.setLeaveMutable(true);
            try {
                messaging.convertAndSendToUser(entry.getKey(), DESTINATION, snapshot, target.getMessageHeaders());
            } catch (org.springframework.messaging.MessagingException failure) {
                org.slf4j.LoggerFactory.getLogger(P2SDeliveryService.class)
                        .debug("Could not push recipient update to disconnected session", failure);
            }
        }
    }

    public Map<String, Object> recipients(String username) {
        SimpUser user = users.getUser(username);
        List<Map<String, Object>> peers = user == null ? List.of() : user.getSessions().stream()
                .map(session -> Map.<String, Object>of("id", session.getId(),
                        "binary", binarySessions.contains(session.getId())))
                .toList();
        return Map.of("format", "ccb1", "recipients", peers);
    }

    private Set<String> requestedRecipients(SimpMessageHeaderAccessor source) {
        String value = org.springframework.messaging.support.NativeMessageHeaderAccessor
                .getFirstNativeHeader(RECIPIENTS_HEADER, source.getMessageHeaders());
        if (value == null) return null;
        if (source.getSessionAttributes() == null
                || !Boolean.TRUE.equals(source.getSessionAttributes().get(BINARY_ATTRIBUTE))
                || value.length() > 32768) throw new IllegalArgumentException("Invalid binary recipients");
        var ids = value.split(",", -1);
        if (ids.length > 256 || Arrays.stream(ids).anyMatch(id -> !id.matches("[A-Za-z0-9_-]{1,128}")))
            throw new IllegalArgumentException("Invalid binary recipients");
        return Arrays.stream(ids).collect(Collectors.toSet());
    }

    public void sendBinary(String username, byte[] data, Long size, SimpMessageHeaderAccessor source) {
        Set<String> requested = requestedRecipients(source);
        if (requested == null) throw new IllegalArgumentException("Binary recipients are required");
        SimpUser user = users.getUser(username);
        if (user == null) return;
        for (var session : user.getSessions()) {
            String recipient = session.getId();
            if (recipient.equals(source.getSessionId()) || !requested.contains(recipient)
                    || !binarySessions.contains(recipient)) continue;
            Long limit = receiveLimits.get(recipient);
            if (size != null && limit != null && limit >= 0 && size > limit) continue;
            var target = SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
            target.setSessionId(recipient);
            target.setContentType(MimeTypeUtils.parseMimeType("application/octet-stream"));
            target.setLeaveMutable(true);
            messaging.convertAndSendToUser(recipient, DESTINATION, data, target.getMessageHeaders());
        }
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
        Set<String> requested = requestedRecipients(source);
        Long size = contentSize(data);
        SimpUser user = users.getUser(username);
        boolean needsFiltering = size != null && user != null && user.getSessions().stream().anyMatch(session -> {
            Long limit = receiveLimits.get(session.getId());
            return !session.getId().equals(sender) && limit != null && limit >= 0 && size > limit;
        });
        if (requested == null && !noEcho && !needsFiltering) {
            // Preserve the exact legacy broadcast when no recipient needs
            // filtering. Old mobile clients require their own echo to unlock.
            messaging.convertAndSendToUser(username, DESTINATION, data);
            return;
        }
        if (user == null) return;
        for (var session : user.getSessions()) {
            String recipient = session.getId();
            if (noEcho && recipient.equals(sender)) continue;
            if (requested != null && !requested.contains(recipient)) continue;
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
