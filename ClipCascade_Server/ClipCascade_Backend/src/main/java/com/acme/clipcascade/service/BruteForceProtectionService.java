package com.acme.clipcascade.service;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

import org.ehcache.Cache;
import org.ehcache.CacheManager;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.constants.ServerConstants;
import com.acme.clipcascade.model.UserAccessTracker;
import com.acme.clipcascade.model.IpAttemptDetails;
import com.acme.clipcascade.model.Timeout;
import com.acme.clipcascade.utils.IpAddressResolver;
import com.acme.clipcascade.utils.TimeUtility;
import com.acme.clipcascade.utils.UserValidator;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import ch.qos.logback.classic.Logger;
import io.micrometer.common.lang.Nullable;
import jakarta.annotation.PreDestroy;

@Service
public class BruteForceProtectionService {

    private final Cache<String, UserAccessTracker> cacheTracker;
    private final Map<String, UserAccessTracker> localTracker;

    private final Map<String, ReentrantLock> userLocks;

    private final ClipCascadeProperties clipCascadeProperties;
    private final ObjectMapper objectMapper;
    private final Logger logger;

    public BruteForceProtectionService(
            @Nullable CacheManager trackerCacheManager,
            ClipCascadeProperties clipCascadeProperties,
            ObjectMapper objectMapper) {

        this.clipCascadeProperties = clipCascadeProperties;

        this.objectMapper = objectMapper;
        logger = (Logger) LoggerFactory.getLogger(BruteForceProtectionService.class);

        userLocks = new ConcurrentHashMap<>();
        if (clipCascadeProperties.isBfaCacheEnabled()) {
            localTracker = null;
            cacheTracker = trackerCacheManager.getCache("tracker", String.class, UserAccessTracker.class);
        } else {
            cacheTracker = null;
            localTracker = new ConcurrentHashMap<>();
        }
    }

    public boolean recordAndValidateAttempt(String username) {
        if (!UserValidator.isValidUsername(username)) {
            return false;
        }

        // get the current(active) user ip address
        String activeIp = IpAddressResolver.getUserIpAddress();

        ReentrantLock lock = getUserLock(username);
        lock.lock(); // acquire the lock for specific username
        try {
            // get user details from tracker using username
            UserAccessTracker userDetails = getOrCreateUserAccessTracker(username);

            // validate lockout time for user
            if (!isTimeoutExpired(userDetails)) {
                return false;
            }

            // add unique ip to the set
            userDetails.getUniqueIpSet().add(activeIp);

            // validate unique ip attempts
            if (hasExceededUniqueIpLimit(userDetails)) {
                userDetails.setUniqueIpSet(new HashSet<>());
                userDetails.setLockTimeout(getLockoutEndTime());
                saveUserDetails(username, userDetails);
                return false;
            }

            // get ip details form the user
            IpAttemptDetails ipDetails = getOrCreateIpAttemptDetails(activeIp, userDetails);

            // validate lockout time for ip
            if (!isTimeoutExpired(ipDetails)) {
                saveUserDetails(username, userDetails);
                return false;
            }

            // increment the attempt count for the ip
            ipDetails.setAttempts(ipDetails.getAttempts() + 1);

            // validate attempts for current ip
            if (hasExceededIpAttemptLimit(ipDetails)) {
                ipDetails.setAttempts(0);
                ipDetails.setLockCount(ipDetails.getLockCount() + 1);
                ipDetails.setLockTimeout(getLockoutEndTimeWithScalingFactor(ipDetails.getLockCount()));
            }

            // save ip details to the tracker
            saveIpDetails(username, activeIp, userDetails, ipDetails);

            return true;
        } finally {
            lock.unlock(); // release the lock
        }
    }

    public IpAttemptDetails removeIpDetails(String username) {
        if (!UserValidator.isValidUsername(username)) {
            return null;
        }

        // get the current(active) user ip address
        String activeIp = IpAddressResolver.getUserIpAddress();

        ReentrantLock lock = getUserLock(username);
        lock.lock(); // acquire the lock for specific username
        try {
            // get user details from tracker using username
            UserAccessTracker userDetails = trackerGet(username);

            // reset unique ip set for the user
            userDetails.setUniqueIpSet(new HashSet<>());

            // remove ip details from the user
            IpAttemptDetails ipDetails = userDetails.getIpAccessDetails().remove(activeIp);

            // save user details to the tracker
            saveUserDetails(username, userDetails);

            return ipDetails;
        } finally {
            lock.unlock(); // release the lock
        }
    }

    public void removeUser(String username) {

        if (UserValidator.isValidUsername(username)) {
            ReentrantLock lock = getUserLock(username);
            lock.lock(); // acquire the lock for specific username
            try {
                trackerRemove(username);
            } finally {
                lock.unlock(); // release the lock
            }
        }
    }

    public UserAccessTracker unlockUser(String username) {
        if (!UserValidator.isValidUsername(username)) {
            return null;
        }

        ReentrantLock lock = getUserLock(username);
        lock.lock(); // acquire the lock for specific username
        try {
            UserAccessTracker userAccessTracker = trackerGet(username);

            if (userAccessTracker == null) {
                return null;
            }

            userAccessTracker.setLockTimeout(TimeUtility.resetTime());

            Map<String, IpAttemptDetails> ipAccessDetails = userAccessTracker.getIpAccessDetails();
            ipAccessDetails.forEach((key, value) -> value.setLockTimeout(TimeUtility.resetTime()));

            saveUserDetails(username, userAccessTracker);

            return userAccessTracker;
        } finally {
            lock.unlock(); // release the lock
        }
    }

    public void cleanUpTracker() {

        // Collect all usernames from the tracker
        Set<String> allUsernames = new HashSet<>();
        if (cacheTracker != null) {
            cacheTracker.forEach(entry -> allUsernames.add(entry.getKey()));
        } else {
            localTracker.forEach((key, value) -> allUsernames.add(key));
        }

        // Iterate over the collected usernames
        for (String username : allUsernames) {
            ReentrantLock lock = getUserLock(username);
            lock.lock(); // acquire the lock for specific username
            try {
                UserAccessTracker userAccessTracker = trackerGet(username);

                if (userAccessTracker == null) {
                    // Already removed or doesn't exist
                    continue;
                }

                // Check if this user can be cleaned up:
                if (userAccessTracker.getIpAccessDetails().isEmpty() &&
                        userAccessTracker.getUniqueIpSet().isEmpty() &&
                        isTimeoutExpired(userAccessTracker)) {

                    // Remove the user from the tracker
                    trackerRemove(username);
                }

            } finally {
                lock.unlock(); // release the lock
            }
        }
    }

    private Map<String, UserAccessTracker> snapshotTracker() {
        Map<String, UserAccessTracker> snapshot = new HashMap<>();
        if (cacheTracker != null) {
            cacheTracker.forEach(entry -> snapshot.put(entry.getKey(), entry.getValue()));
        } else {
            localTracker.forEach((key, value) -> snapshot.put(key, value));
        }
        return snapshot;
    }

    public byte[] getTrackerFile() throws JsonProcessingException {
        String jsonString = objectMapper.writeValueAsString(snapshotTracker());
        return jsonString.getBytes(StandardCharsets.UTF_8);
    }

    public Map<String, UserAccessTracker> getTracker() {
        return snapshotTracker();
    }

    /**
     * Acquire a ReentrantLock for a given username from the userLocks map.
     * If it doesn't exist, create it. This ensures the same username uses the same
     * lock.
     */
    private ReentrantLock getUserLock(String username) {
        return userLocks.computeIfAbsent(username, u -> new ReentrantLock());
    }

    private UserAccessTracker getOrCreateUserAccessTracker(String username) {
        UserAccessTracker userAccessTracker = trackerGet(username);

        if (userAccessTracker == null) {
            userAccessTracker = new UserAccessTracker(
                    new HashMap<>(),
                    new HashSet<>(),
                    TimeUtility.resetTime());
        }

        return userAccessTracker;
    }

    private IpAttemptDetails getOrCreateIpAttemptDetails(
            String activeIp,
            UserAccessTracker userDetails) {

        return userDetails.getIpAccessDetails().getOrDefault(activeIp, new IpAttemptDetails());
    }

    private void saveIpDetails(
            String username,
            String activeIp,
            UserAccessTracker userDetails,
            IpAttemptDetails ipDetails) {

        // save ip details to the user
        userDetails.getIpAccessDetails().put(activeIp, ipDetails);

        // save user details to the tracker
        saveUserDetails(username, userDetails);
    }

    private UserAccessTracker trackerGet(String username) {
        return (cacheTracker != null)
                ? cacheTracker.get(username)
                : localTracker.get(username);
    }

    private void trackerPut(String username, UserAccessTracker userAccessTracker) {
        if (cacheTracker != null) {
            cacheTracker.put(username, userAccessTracker);
        } else {
            localTracker.put(username, userAccessTracker);
        }
    }

    private void trackerRemove(String username) {
        if (cacheTracker != null) {
            cacheTracker.remove(username);
        } else {
            localTracker.remove(username);
        }
    }

    private void saveUserDetails(String username, UserAccessTracker userDetails) {
        trackerPut(username, userDetails);
    }

    private boolean hasExceededUniqueIpLimit(UserAccessTracker userDetails) {
        return userDetails.getUniqueIpSet().size() > clipCascadeProperties.getMaxUniqueIpAttempts();
    }

    private boolean hasExceededIpAttemptLimit(IpAttemptDetails ipDetails) {
        return ipDetails.getAttempts() >= clipCascadeProperties.getMaxAttemptsPerIp();
    }

    private boolean isTimeoutExpired(Timeout timeout) {
        return timeout.getLockTimeout() < TimeUtility.getCurrentTimeInSeconds();
    }

    private long getLockoutEndTime() {
        return TimeUtility.getCurrentTimeInSeconds() + clipCascadeProperties.getLockTimeoutSeconds();
    }

    private long getLockoutEndTimeWithScalingFactor(int count) {
        return TimeUtility.getCurrentTimeInSeconds() + (clipCascadeProperties.getLockTimeoutSeconds()
                * (count * clipCascadeProperties.getLockTimeoutScalingFactor()));
    }

    // On application shutdown, save the tracker snapshot
    @PreDestroy
    public void trackerSnapshot() {
        if (!clipCascadeProperties.isLogBruteForceTrackerEnabled()) {
            return;
        }

        try {
            logger.info("Starting the process of saving the Brute Force Protection Tracker snapshot to disk...");

            // Define the directory path for saving the tracker snapshot
            String databaseFolder = ServerConstants.BFA_TRACKER_LOG_PATH;
            File databaseDir = new File(databaseFolder);
            if (!databaseDir.exists()) {
                Files.createDirectories(Paths.get(databaseFolder));
            }

            // Create the file name with timestamp
            String fileName = "brute_force_tracker_snapshot_" + TimeUtility.getCurrentDateTime() + ".json";
            File jsonFile = new File(databaseDir, fileName);

            // Build a snapshot map
            Map<String, UserAccessTracker> snapshotMap = snapshotTracker();

            // Serialize only the snapshot map (not the entire Ehcache tracker)
            objectMapper.writeValue(jsonFile, snapshotMap);

            logger.info("Brute Force Protection Tracker snapshot successfully saved to: "
                    + databaseFolder + "/" + fileName);
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

}
