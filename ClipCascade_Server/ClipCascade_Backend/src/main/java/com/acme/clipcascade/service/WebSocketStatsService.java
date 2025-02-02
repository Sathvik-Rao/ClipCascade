package com.acme.clipcascade.service;

import org.springframework.stereotype.Service;
import org.springframework.web.socket.config.WebSocketMessageBrokerStats;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.config.P2PWebSocketHandler;

import jakarta.annotation.Nullable;

@Service
public class WebSocketStatsService {

    private final WebSocketMessageBrokerStats p2sWebSocketStats;
    private final P2PWebSocketHandler p2pWebSocketHandler;

    public WebSocketStatsService(
            ClipCascadeProperties clipCascadeProperties,
            @Nullable WebSocketMessageBrokerStats p2sWebSocketStats,
            @Nullable P2PWebSocketHandler p2pWebSocketHandler) {

        if (clipCascadeProperties.isP2pEnabled()) {
            this.p2sWebSocketStats = null;
            this.p2pWebSocketHandler = p2pWebSocketHandler;
        } else {
            this.p2pWebSocketHandler = null;
            this.p2sWebSocketStats = p2sWebSocketStats;
        }
    }

    public String getWebSocketStats() {
        if (p2pWebSocketHandler != null) {
            return p2pWebSocketHandler.toString();
        } else {
            return p2sWebSocketStats.toString();
        }
    }
}
