package com.acme.clipcascade.service;

import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import com.acme.clipcascade.config.P2PWebSocketHandler;
import com.acme.clipcascade.constants.ServerConstants;

import ch.qos.logback.classic.Logger;

@Component
@ConditionalOnProperty(prefix = "app.p2p", name = "enabled", havingValue = "true", matchIfMissing = false)
public class P2PScheduledTasks {

    private final P2PWebSocketHandler p2pWebSocketHandler;
    private final Logger logger;

    private static final long THIRTY_MINUTES = 30 * 60 * 1000;

    public P2PScheduledTasks(P2PWebSocketHandler p2pWebSocketHandler) {
        this.p2pWebSocketHandler = p2pWebSocketHandler;
        this.logger = (Logger) LoggerFactory.getLogger(P2PScheduledTasks.class);
    }

    @Scheduled(fixedDelay = THIRTY_MINUTES)
    public void logPeerToPeerWebSocketStatistics() {
        logger.info(p2pWebSocketHandler.toString()); // log p2p web socket stats
    }

    @Scheduled(fixedRate = ServerConstants.HEARTBEAT_SEND_INTERVAL_P2P)
    public void sendP2PHeartbeats() {
        p2pWebSocketHandler.sendAndCheckHeartbeats(); // send p2p heartbeats
    }

}
