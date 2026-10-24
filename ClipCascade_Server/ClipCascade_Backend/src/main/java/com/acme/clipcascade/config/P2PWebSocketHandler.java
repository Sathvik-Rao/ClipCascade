package com.acme.clipcascade.config;

import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.PongMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

import com.acme.clipcascade.constants.ServerConstants;
import com.acme.clipcascade.utils.MapUtility;
import com.acme.clipcascade.utils.TimeUtility;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import ch.qos.logback.classic.Logger;
import jakarta.annotation.PreDestroy;

@Component
@ConditionalOnProperty(prefix = "app.p2p", name = "enabled", havingValue = "true", matchIfMissing = false)
public class P2PWebSocketHandler extends AbstractWebSocketHandler {

    private final ObjectMapper objectMapper;
    private final Logger logger;
    private final long MAX_GLOBAL_CONNECTIONS;
    private final long MAX_CONNECTIONS_PER_USER;
    private final int SIGNALING_RATE_LIMIT_PER_SEC;

    private final Map<String, Map<String, WebSocketSession>> sessions = new ConcurrentHashMap<>();
    private final Map<String, Map<String, String>> sessionsUUID = new ConcurrentHashMap<>();
    private final Map<String, ReentrantLock> userLocks = new ConcurrentHashMap<>();
    private final Map<String, Long> lastHeartbeat = new ConcurrentHashMap<>();
    private final Map<String, ReentrantLock> sessionLocks = new ConcurrentHashMap<>();
    // Per-session token bucket for signaling messages. Each entry holds [tokens, lastRefillMs].
    private final Map<String, double[]> rateBuckets = new ConcurrentHashMap<>();

    private final AtomicLong activeConnections = new AtomicLong();
    private final AtomicLong totalConnections = new AtomicLong();
    private final AtomicLong totalInboundMessages = new AtomicLong();
    private final AtomicLong totalOutboundMessages = new AtomicLong();
    private final AtomicLong totalRateLimitedMessages = new AtomicLong();

    public P2PWebSocketHandler(ObjectMapper objectMapper, ClipCascadeProperties clipCascadeProperties) {
        this.objectMapper = objectMapper;
        this.MAX_GLOBAL_CONNECTIONS = clipCascadeProperties.getMaxWsGlobalConnections();
        this.MAX_CONNECTIONS_PER_USER = clipCascadeProperties.getMaxWsConnectionsPerUser();
        this.SIGNALING_RATE_LIMIT_PER_SEC = clipCascadeProperties.getP2pSignalingRateLimitPerSec();
        this.logger = (Logger) LoggerFactory.getLogger(P2PWebSocketHandler.class);
    }

    /**
     * Token-bucket rate check. Returns true if the message is allowed, false if
     * it should be dropped. Disabled (always allows) when the configured limit
     * is <= 0 to keep behavior identical to pre-rate-limit deployments.
     *
     * Bucket capacity equals the per-second rate, so short bursts are tolerated.
     */
    private boolean isWithinRateLimit(String sessionId) {
        int ratePerSec = SIGNALING_RATE_LIMIT_PER_SEC;
        if (ratePerSec <= 0) {
            return true;
        }
        long now = System.currentTimeMillis();
        double[] bucket = rateBuckets.computeIfAbsent(
                sessionId, sid -> new double[] { ratePerSec, now });
        synchronized (bucket) {
            double elapsedSec = (now - (long) bucket[1]) / 1000.0;
            if (elapsedSec > 0) {
                bucket[0] = Math.min(ratePerSec, bucket[0] + elapsedSec * ratePerSec);
                bucket[1] = now;
            }
            if (bucket[0] >= 1.0) {
                bucket[0] -= 1.0;
                return true;
            }
            return false;
        }
    }

    @Override
    public void afterConnectionEstablished(@NonNull WebSocketSession session) throws Exception {
        incrementCounter(activeConnections);
        incrementCounter(totalConnections);

        // Global connections check
        if (MAX_GLOBAL_CONNECTIONS != -1 && getActiveConnections() > MAX_GLOBAL_CONNECTIONS) {
            logger.warn("Global max WebSocket connections ({}) exceeded. Closing new session...",
                    MAX_GLOBAL_CONNECTIONS);
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }

        Principal principal = session.getPrincipal();
        if (principal == null) {
            logger.warn("Principal is null. Closing new session...");
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }

        String username = principal.getName();
        // Generate a unique Peer ID for this session
        String peerId = UUID.randomUUID().toString();

        ReentrantLock lock = getUserLock(username);
        lock.lock(); // acquire the lock for specific username
        try {
            // Per-user connections check
            Map<String, WebSocketSession> existingSessions = sessions.get(username);
            if (MAX_CONNECTIONS_PER_USER != -1
                    && existingSessions != null
                    && existingSessions.size() >= MAX_CONNECTIONS_PER_USER) {
                logger.warn("User {} exceeded max allowed connections ({}). Closing session...",
                        username, MAX_CONNECTIONS_PER_USER);
                session.close(CloseStatus.POLICY_VIOLATION);
                return;
            }

            lastHeartbeat.put(session.getId(), TimeUtility.getCurrentTimeInMilliseconds());

            sessions
                    .computeIfAbsent(username, k -> new ConcurrentHashMap<>())
                    .put(session.getId(), session);

            sessionsUUID
                    .computeIfAbsent(username, k -> new ConcurrentHashMap<>())
                    .put(session.getId(), peerId);

            getSessionLock(session.getId());

            // Notify *this* client of its assigned peerId
            Map<String, Object> yourIdMsg = new HashMap<>();
            yourIdMsg.put("type", "ASSIGNED_ID");
            yourIdMsg.put("peerId", peerId);
            TextMessage jsonStr = new TextMessage(objectMapper.writeValueAsString(yourIdMsg));

            sendMessage(session, jsonStr);

            // Broadcast updated peer list to everyone in that user's room
            broadcastPeerList(username);
        } finally {
            lock.unlock(); // release the lock
        }
    }

    @Override
    public void afterConnectionClosed(@NonNull WebSocketSession session, @NonNull CloseStatus status) throws Exception {
        decrementCounter(activeConnections);

        Principal principal = session.getPrincipal();
        if (principal == null) {
            return;
        }

        String username = principal.getName();

        ReentrantLock lock = getUserLock(username);
        lock.lock(); // acquire the lock for specific username
        try {

            Map<String, WebSocketSession> userSessions = sessions.get(username);
            if (userSessions != null) {
                userSessions.remove(session.getId());
                if (userSessions.isEmpty()) {
                    sessions.remove(username);
                }
            }

            Map<String, String> userSessionsUUID = sessionsUUID.get(username);
            if (userSessionsUUID != null) {
                userSessionsUUID.remove(session.getId());
                if (userSessionsUUID.isEmpty()) {
                    sessionsUUID.remove(username);
                }
            }

            lastHeartbeat.remove(session.getId());
            sessionLocks.remove(session.getId());
            rateBuckets.remove(session.getId());

            // Notify everyone else in that user's room
            broadcastPeerList(username);
        } finally {
            lock.unlock(); // release the lock
        }
    }

    public void sendAndCheckHeartbeats() {
        long now = TimeUtility.getCurrentTimeInMilliseconds();

        for (Map<String, WebSocketSession> userSessionMap : sessions.values()) {
            for (WebSocketSession session : userSessionMap.values()) {
                if (session == null || !session.isOpen()) {
                    continue;
                }
                String sessionId = session.getId();
                ReentrantLock sessionLock = getSessionLock(sessionId);

                // Attempt to lock without blocking
                if (sessionLock.tryLock()) {
                    try {
                        // Send ping frame
                        session.sendMessage(new PingMessage());
                        incrementCounter(totalOutboundMessages);
                    } catch (Exception e) {
                        logger.debug("Failed to send ping to session {}: {}", sessionId, e.getMessage());
                    } finally {
                        sessionLock.unlock();
                    }
                } else {
                    logger.debug("Skipping heartbeat for session {} because the lock was not free", sessionId);
                }

                // Check if we've received a recent "\n" back
                Long lastHbTime = lastHeartbeat.get(sessionId);
                if (lastHbTime == null) {
                    lastHbTime = 0L;
                }

                if ((now - lastHbTime) > ServerConstants.HEARTBEAT_RECEIVE_INTERVAL_P2P) {
                    logger.debug("Closing session {} due to missed heartbeat.", sessionId);
                    try {
                        session.close(CloseStatus.GOING_AWAY);
                    } catch (Exception e) {
                        logger.debug("Failed to close session {}: {}", sessionId, e.getMessage());
                    }
                }
            }
        }
    }

    @Override
    protected void handleTextMessage(@NonNull WebSocketSession session, @NonNull TextMessage message) throws Exception {
        incrementCounter(totalInboundMessages);

        if (message.getPayload().isEmpty()) {
            return;
        }

        if (!isWithinRateLimit(session.getId())) {
            incrementCounter(totalRateLimitedMessages);
            logger.debug("Rate-limited signaling message from session {}", session.getId());
            return;
        }

        Principal principal = session.getPrincipal();
        if (principal == null) {
            return;
        }

        String username = principal.getName();

        ReentrantLock lock = getUserLock(username);
        lock.lock(); // acquire the lock for specific username
        try {
            Map<String, WebSocketSession> userSessions = sessions.get(username);
            if (userSessions == null) {
                return;
            }

            Map<String, String> userSessionsUUID = sessionsUUID.get(username);
            if (userSessionsUUID == null) {
                return;
            }

            JsonNode json = objectMapper.readTree(message.getPayload());
            /*
             * Expecting messages of form:
             * {
             * "type": "OFFER" | "ANSWER" | "ICE_CANDIDATE",
             * "fromPeerId": "...",
             * "toPeerId": "...",
             * "offer"/"answer"/"candidate": {...}
             * }
             */

            String type = json.has("type") ? json.get("type").asText() : "";
            String toPeerId = json.has("toPeerId") ? json.get("toPeerId").asText() : null;

            if ("OFFER".equals(type) || "ANSWER".equals(type) || "ICE_CANDIDATE".equals(type)) {
                // Forward to the correct session within this user's room
                if (toPeerId != null) {
                    String targetSessionId = MapUtility.getKeyByValue(userSessionsUUID, toPeerId);
                    if (targetSessionId != null) {
                        WebSocketSession targetSession = userSessions.get(targetSessionId);
                        sendMessage(targetSession, message);
                    }
                }
            }
        } finally {
            lock.unlock(); // release the lock
        }
    }

    @Override
    protected void handleBinaryMessage(@NonNull WebSocketSession session, @NonNull BinaryMessage message)
            throws Exception {

        handleTextMessage(session, new TextMessage(new String(message.getPayload().array(), StandardCharsets.UTF_8)));
    }

    @Override
    protected void handlePongMessage(@NonNull WebSocketSession session, @NonNull PongMessage message) throws Exception {
        lastHeartbeat.put(session.getId(), TimeUtility.getCurrentTimeInMilliseconds());
    }

    @PreDestroy
    public void shutdown() {
        for (Map<String, WebSocketSession> userSessions : sessions.values()) {
            for (WebSocketSession session : userSessions.values()) {
                try {
                    if (session != null && session.isOpen()) {
                        session.close();
                    }
                } catch (Exception e) {
                    logger.debug("Failed to close WebSocket session(P2P): ", e);
                }
            }
        }
    }

    private void sendMessage(WebSocketSession session, TextMessage message) {
        if (session == null || !session.isOpen()) {
            return;
        }

        ReentrantLock sessionLock = getSessionLock(session.getId());
        sessionLock.lock(); // acquire the lock for specific session
        try {
            session.sendMessage(message);
            incrementCounter(totalOutboundMessages);
        } catch (Exception e) {
            logger.debug("Failed to send WebSocket message(P2P): ", e);
        } finally {
            sessionLock.unlock(); // release the lock
        }
    }

    private void broadcastPeerList(String username) throws Exception {

        Map<String, WebSocketSession> userSessions = sessions.get(username);
        if (userSessions == null) {
            return;
        }

        Map<String, String> userSessionsUUID = sessionsUUID.get(username);
        if (userSessionsUUID == null) {
            return;
        }

        // Gather all peerIds in this user's room
        Set<String> allPeerIds = new HashSet<>(userSessionsUUID.values());

        // Construct a message
        Map<String, Object> msg = new HashMap<>();
        msg.put("type", "PEER_LIST");
        msg.put("peers", allPeerIds);
        TextMessage jsonStr = new TextMessage(objectMapper.writeValueAsString(msg));

        // Send to all sessions in that user's room
        for (WebSocketSession session : userSessions.values()) {
            sendMessage(session, jsonStr);
        }

    }

    public int getConnectionsForUser(String username) {
        Map<String, WebSocketSession> userSessions = sessions.get(username);
        if (userSessions == null) {
            return 0;
        }
        return userSessions.size();
    }

    /**
     * Snapshot of every currently-connected user and how many active sessions
     * they hold. Returned as a fresh map so callers (admin UI) can iterate
     * safely.
     */
    public Map<String, Integer> getOnlineUsers() {
        Map<String, Integer> snapshot = new HashMap<>();
        for (Map.Entry<String, Map<String, WebSocketSession>> entry : sessions.entrySet()) {
            Map<String, WebSocketSession> userSessions = entry.getValue();
            if (userSessions == null) {
                continue;
            }
            int liveCount = 0;
            for (WebSocketSession s : userSessions.values()) {
                if (s != null && s.isOpen()) {
                    liveCount++;
                }
            }
            if (liveCount > 0) {
                snapshot.put(entry.getKey(), liveCount);
            }
        }
        return snapshot;
    }

    /**
     * Acquire a ReentrantLock for a given username from the userLocks map.
     * If it doesn't exist, create it. This ensures the same username uses the same
     * lock.
     */
    private ReentrantLock getUserLock(String username) {
        return userLocks.computeIfAbsent(username, u -> new ReentrantLock());
    }

    private ReentrantLock getSessionLock(String sessionId) {
        return sessionLocks.computeIfAbsent(sessionId, sid -> new ReentrantLock());
    }

    public Long getActiveConnections() {
        return activeConnections.get();
    }

    public Long getTotalConnections() {
        return totalConnections.get();
    }

    public Long getTotalInboundMessages() {
        return totalInboundMessages.get();
    }

    public Long getTotalOutboundMessages() {
        return totalOutboundMessages.get();
    }

    public Long getTotalRateLimitedMessages() {
        return totalRateLimitedMessages.get();
    }

    private void incrementCounter(AtomicLong counter) {
        counter.incrementAndGet();
    }

    private void decrementCounter(AtomicLong counter) {
        counter.decrementAndGet();
    }

    @Override
    public String toString() {
        return "WebSocketStats {\n" +
                " Active Connections=" + getActiveConnections() +
                ",\n Total Connections=" + getTotalConnections() +
                ",\n Total Inbound Messages=" + getTotalInboundMessages() +
                ",\n Total Outbound Messages=" + getTotalOutboundMessages() +
                ",\n Total Rate Limited Messages=" + getTotalRateLimitedMessages() +
                "\n }\n";
    }

}
