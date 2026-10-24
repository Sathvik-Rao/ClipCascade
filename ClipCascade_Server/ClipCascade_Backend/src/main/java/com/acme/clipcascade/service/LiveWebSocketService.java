package com.acme.clipcascade.service;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.WebSocketHandlerDecorator;

/** Tracks local transports so revoking a login also disconnects its live sockets. */
@Service
public class LiveWebSocketService {
    private static final Logger logger = LoggerFactory.getLogger(LiveWebSocketService.class);
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    public WebSocketHandler decorate(WebSocketHandler handler) {
        return new WebSocketHandlerDecorator(handler) {
            @Override
            public void afterConnectionEstablished(WebSocketSession session) throws Exception {
                sessions.put(session.getId(), session);
                try {
                    super.afterConnectionEstablished(session);
                } catch (Exception ex) {
                    sessions.remove(session.getId(), session);
                    throw ex;
                } finally {
                    if (!session.isOpen()) {
                        sessions.remove(session.getId(), session);
                    }
                }
            }

            @Override
            public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
                sessions.remove(session.getId(), session);
                super.afterConnectionClosed(session, status);
            }
        };
    }

    public void disconnectUser(String username) {
        sessions.values().stream()
                .filter(session -> session.getPrincipal() != null
                        && username.equals(session.getPrincipal().getName()))
                .forEach(this::disconnect);
    }

    public void disconnectAll() {
        sessions.values().forEach(this::disconnect);
    }

    private void disconnect(WebSocketSession session) {
        try {
            session.close(new CloseStatus(1008, "Session revoked"));
        } catch (IOException ex) {
            logger.warn("Could not close a revoked WebSocket connection", ex);
        }
    }
}
