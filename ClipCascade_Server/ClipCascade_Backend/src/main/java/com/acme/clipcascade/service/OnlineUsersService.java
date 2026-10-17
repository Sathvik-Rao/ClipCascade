package com.acme.clipcascade.service;

import java.security.Principal;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;
import java.util.stream.Collectors;

import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.messaging.SessionConnectedEvent;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.config.P2PWebSocketHandler;
import com.acme.clipcascade.model.PageResponse;
import com.acme.clipcascade.utils.PagingUtility;

import jakarta.annotation.Nullable;

/**
 * Tracks which users currently have open WebSocket connections and how many
 * connections each user holds. Works in both modes:
 *  - P2P: delegates to P2PWebSocketHandler, which owns the live session map.
 *  - P2S: listens to STOMP SessionConnected/Disconnect events and maintains
 *         an in-memory counter keyed by authenticated username.
 */
@Service
public class OnlineUsersService {

    private final boolean p2pMode;
    private final P2PWebSocketHandler p2pWebSocketHandler;

    // P2S-only state. Keyed by username -> live connection count.
    private final Map<String, AtomicInteger> p2sConnectionCounts = new ConcurrentHashMap<>();
    // sessionId -> username, so the disconnect event can decrement the right entry
    // (the disconnect event does not always carry the user Principal).
    private final Map<String, String> p2sSessionToUser = new ConcurrentHashMap<>();

    public OnlineUsersService(
            ClipCascadeProperties clipCascadeProperties,
            @Nullable P2PWebSocketHandler p2pWebSocketHandler) {

        this.p2pMode = clipCascadeProperties.isP2pEnabled();
        this.p2pWebSocketHandler = p2pWebSocketHandler;
    }

    @EventListener
    public void onSessionConnected(SessionConnectedEvent event) {
        if (p2pMode) {
            return;
        }
        StompHeaderAccessor accessor = StompHeaderAccessor.wrap(event.getMessage());
        Principal principal = accessor.getUser();
        String sessionId = accessor.getSessionId();
        if (principal == null || sessionId == null) {
            return;
        }
        String username = principal.getName();
        p2sSessionToUser.put(sessionId, username);
        p2sConnectionCounts
                .computeIfAbsent(username, k -> new AtomicInteger(0))
                .incrementAndGet();
    }

    @EventListener
    public void onSessionDisconnect(SessionDisconnectEvent event) {
        if (p2pMode) {
            return;
        }
        StompHeaderAccessor accessor = StompHeaderAccessor.wrap(event.getMessage());
        String sessionId = accessor.getSessionId();
        if (sessionId == null) {
            return;
        }
        String username = p2sSessionToUser.remove(sessionId);
        if (username == null) {
            return;
        }
        AtomicInteger count = p2sConnectionCounts.get(username);
        if (count != null && count.decrementAndGet() <= 0) {
            p2sConnectionCounts.remove(username);
        }
    }

    public Map<String, Integer> getOnlineUsers() {
        if (p2pMode) {
            if (p2pWebSocketHandler == null) {
                return new HashMap<>();
            }
            return p2pWebSocketHandler.getOnlineUsers();
        }
        Map<String, Integer> snapshot = new HashMap<>();
        for (Map.Entry<String, AtomicInteger> entry : p2sConnectionCounts.entrySet()) {
            int v = entry.getValue().get();
            if (v > 0) {
                snapshot.put(entry.getKey(), v);
            }
        }
        return snapshot;
    }

    /**
     * Single online-users row, flattened from the username->count map so
     * PagingUtility can sort/filter/paginate over a list. Public so the
     * controller can render it as JSON without a custom serializer.
     */
    public static class OnlineUserRow {
        private String username;
        private int connections;

        public OnlineUserRow() {
        }

        public OnlineUserRow(String username, int connections) {
            this.username = username;
            this.connections = connections;
        }

        public String getUsername() {
            return username;
        }

        public void setUsername(String username) {
            this.username = username;
        }

        public int getConnections() {
            return connections;
        }

        public void setConnections(int connections) {
            this.connections = connections;
        }
    }

    private static final Map<String, Comparator<OnlineUserRow>> ONLINE_USERS_COMPARATORS = Map.of(
            "username", Comparator.comparing(OnlineUserRow::getUsername,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)),
            "connections", Comparator.comparingInt(OnlineUserRow::getConnections));

    public PageResponse<OnlineUserRow> getOnlineUsersPage(
            int page,
            int size,
            String sort,
            String direction,
            String search) {

        List<OnlineUserRow> rows = getOnlineUsers().entrySet().stream()
                .map(e -> new OnlineUserRow(e.getKey(), e.getValue() == null ? 0 : e.getValue()))
                .collect(Collectors.toList());

        String needle = (search == null) ? "" : search.trim().toLowerCase();
        Predicate<OnlineUserRow> filter = needle.isEmpty()
                ? null
                : r -> PagingUtility.contains(r.getUsername(), needle);

        String effectiveSort = (sort == null || sort.isEmpty()) ? "connections" : sort;
        String effectiveDir = (direction == null || direction.isEmpty()) ? "desc" : direction;

        return PagingUtility.apply(
                rows,
                filter,
                ONLINE_USERS_COMPARATORS,
                effectiveSort,
                effectiveDir,
                page,
                size,
                search);
    }
}
