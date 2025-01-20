package com.acme.clipcascade.service;

import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.acme.clipcascade.config.P2PWebSocketHandler;

import ch.qos.logback.classic.Logger;
import jakarta.annotation.Nullable;

@Component
public class ScheduledTask {

    private final BruteForceProtectionService bruteForceProtectionService;
    private final P2PWebSocketHandler p2pWebSocketHandler;
    private final Logger logger;

    private static final long ONE_HOUR = 60 * 60 * 1000;
    private static final long THIRTY_MINUTES = 30 * 60 * 1000;

    public ScheduledTask(
            BruteForceProtectionService bruteForceProtectionService,
            @Nullable P2PWebSocketHandler p2pWebSocketHandler) {

        this.bruteForceProtectionService = bruteForceProtectionService;
        this.p2pWebSocketHandler = p2pWebSocketHandler;
        this.logger = (Logger) LoggerFactory.getLogger(ScheduledTask.class);
    }

    @Scheduled(fixedDelay = ONE_HOUR)
    public void cleanUpBruteForceTracker() {
        bruteForceProtectionService.cleanUpTracker(); // clean up bfp tracker
    }

    @Scheduled(fixedDelay = THIRTY_MINUTES)
    public void logPeerToPeerWebSocketStatistics() {
        if (p2pWebSocketHandler == null) {
            return;
        }

        logger.info(p2pWebSocketHandler.toString()); // log p2p web socket stats
    }

}
