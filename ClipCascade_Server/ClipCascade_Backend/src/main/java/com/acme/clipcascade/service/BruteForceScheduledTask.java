package com.acme.clipcascade.service;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class BruteForceScheduledTask {

    private final BruteForceProtectionService bruteForceProtectionService;

    private static final long ONE_HOUR = 60 * 60 * 1000;

    public BruteForceScheduledTask(BruteForceProtectionService bruteForceProtectionService) {
        this.bruteForceProtectionService = bruteForceProtectionService;
    }

    @Scheduled(fixedDelay = ONE_HOUR)
    public void cleanUpBruteForceTracker() {
        bruteForceProtectionService.cleanUpTracker(); // clean up bfp tracker
    }

}
