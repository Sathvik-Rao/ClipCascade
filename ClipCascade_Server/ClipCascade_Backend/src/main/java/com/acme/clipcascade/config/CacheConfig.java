package com.acme.clipcascade.config;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;

import org.ehcache.CacheManager;
import org.ehcache.config.builders.CacheConfigurationBuilder;
import org.ehcache.config.builders.CacheManagerBuilder;
import org.ehcache.config.builders.ResourcePoolsBuilder;
import org.ehcache.config.units.MemoryUnit;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import com.acme.clipcascade.constants.ServerConstants;
import com.acme.clipcascade.model.UserAccessTracker;
import com.acme.clipcascade.service.SystemInfoService;

import ch.qos.logback.classic.Logger;

@Configuration
@EnableCaching
@ConditionalOnProperty(prefix = "app.bfa.cache", name = "enabled", havingValue = "true", matchIfMissing = false)
public class CacheConfig {

    private final SystemInfoService systemInfoService;
    private final ClipCascadeProperties clipCascadeProperties;
    private final Logger logger;

    public CacheConfig(
            SystemInfoService systemInfoService,
            ClipCascadeProperties clipCascadeProperties) {

        this.systemInfoService = systemInfoService;
        this.clipCascadeProperties = clipCascadeProperties;
        this.logger = (Logger) LoggerFactory.getLogger(CacheConfig.class);
    }

    @Bean
    public CacheManager trackerCacheManager() throws IOException {

        // Maximum JVM entries
        int maxHeapEntries = clipCascadeProperties.getBfaTrackerCacheMaxJvmEntries();
        if (maxHeapEntries <= 0) {
            maxHeapEntries = 1;
        }

        // x% <- of available RAM
        int ramPercentage = clipCascadeProperties.getBfaTrackerCacheRamPercentage();
        long offheapSize = 1 * 1024 * 1024;
        if (ramPercentage > 0) {
            offheapSize = (ramPercentage
                    *
                    Math.min(
                            systemInfoService.getAvailableRamInBytes(),
                            systemInfoService.getMaxDirectMemoryInBytes()))
                    / 100;
        }

        // x% <- of available disk space
        int diskPercentage = clipCascadeProperties.getBfaTrackerCacheDiskPercentage();
        long diskSize = 2 * 1024 * 1024;
        if (diskPercentage > 0) {
            diskSize = (diskPercentage * systemInfoService.getAvailableDiskSpaceInBytes()) / 100;
        }

        // make sure diskSize is always greater than offheapSize
        if (!(diskSize > offheapSize)) {
            offheapSize = diskSize - 1;
        }

        // Get the cache directory
        String cachePath = ServerConstants.BFA_TRACKER_CACHE_PATH;
        logger.info("Initializing cache folder for Brute Force Protection Tracker at: " + cachePath);

        File cacheDir = new File(cachePath);

        // Create the directory if it doesn't exist
        if (!cacheDir.exists()) {
            Files.createDirectories(Paths.get(cachePath));
        }

        return CacheManagerBuilder
                .newCacheManagerBuilder()
                .with(CacheManagerBuilder.persistence(cacheDir))
                .withCache(
                        "tracker",
                        CacheConfigurationBuilder.newCacheConfigurationBuilder(
                                String.class,
                                UserAccessTracker.class,
                                ResourcePoolsBuilder
                                        .heap(maxHeapEntries) // <- JVM RAM
                                                              // (entries)
                                        .offheap(offheapSize, MemoryUnit.B) // <-
                                                                            // Ehcache
                                                                            // RAM
                                                                            // (size)
                                        .disk(diskSize, MemoryUnit.B, false))) // <-
                                                                               // Ehcache
                                                                               // Disk
                                                                               // (size)
                .build(true);

    }

}
