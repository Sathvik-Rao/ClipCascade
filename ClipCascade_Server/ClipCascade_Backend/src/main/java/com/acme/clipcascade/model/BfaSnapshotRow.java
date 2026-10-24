package com.acme.clipcascade.model;

/**
 * Flattened "username + sourceIp" row derived from the nested BFA tracker map.
 * Each entry in UserAccessTracker.ipAccessDetails expands into one row, so
 * sort/filter/paginate can run over a single list on the server.
 */
public class BfaSnapshotRow {

    private String username;
    private String sourceIp;
    private int attempts;
    private int lockCount;
    private long lockTimeout;
    private int uniqueIpCount;
    private long userLockTimeout;

    public BfaSnapshotRow() {
    }

    public BfaSnapshotRow(
            String username,
            String sourceIp,
            int attempts,
            int lockCount,
            long lockTimeout,
            int uniqueIpCount,
            long userLockTimeout) {

        this.username = username;
        this.sourceIp = sourceIp;
        this.attempts = attempts;
        this.lockCount = lockCount;
        this.lockTimeout = lockTimeout;
        this.uniqueIpCount = uniqueIpCount;
        this.userLockTimeout = userLockTimeout;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getSourceIp() {
        return sourceIp;
    }

    public void setSourceIp(String sourceIp) {
        this.sourceIp = sourceIp;
    }

    public int getAttempts() {
        return attempts;
    }

    public void setAttempts(int attempts) {
        this.attempts = attempts;
    }

    public int getLockCount() {
        return lockCount;
    }

    public void setLockCount(int lockCount) {
        this.lockCount = lockCount;
    }

    public long getLockTimeout() {
        return lockTimeout;
    }

    public void setLockTimeout(long lockTimeout) {
        this.lockTimeout = lockTimeout;
    }

    public int getUniqueIpCount() {
        return uniqueIpCount;
    }

    public void setUniqueIpCount(int uniqueIpCount) {
        this.uniqueIpCount = uniqueIpCount;
    }

    public long getUserLockTimeout() {
        return userLockTimeout;
    }

    public void setUserLockTimeout(long userLockTimeout) {
        this.userLockTimeout = userLockTimeout;
    }
}
