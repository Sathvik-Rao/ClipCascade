package com.acme.clipcascade.model;

import java.io.Serializable;
import java.util.HashSet;
import java.util.Map;

public class UserAccessTracker implements Timeout, Serializable {
    private static final long serialVersionUID = 1L;

    private Map<String, IpAttemptDetails> ipAccessDetails;
    private HashSet<String> uniqueIpSet;
    private long lockTimeout;

    public UserAccessTracker() {
    }

    public UserAccessTracker(Map<String, IpAttemptDetails> ipAccessDetails, HashSet<String> uniqueIpSet,
            long lockTimeout) {
        this.ipAccessDetails = ipAccessDetails;
        this.uniqueIpSet = uniqueIpSet;
        this.lockTimeout = lockTimeout;
    }

    public Map<String, IpAttemptDetails> getIpAccessDetails() {
        return this.ipAccessDetails;
    }

    public void setIpAccessDetails(Map<String, IpAttemptDetails> ipAccessDetails) {
        this.ipAccessDetails = ipAccessDetails;
    }

    public HashSet<String> getUniqueIpSet() {
        return this.uniqueIpSet;
    }

    public void setUniqueIpSet(HashSet<String> uniqueIpSet) {
        this.uniqueIpSet = uniqueIpSet;
    }

    @Override
    public long getLockTimeout() {
        return this.lockTimeout;
    }

    @Override
    public void setLockTimeout(long lockTimeout) {
        this.lockTimeout = lockTimeout;
    }

    @Override
    public String toString() {
        return "{" +
                " ipAccessDetails='" + getIpAccessDetails() + "'" +
                ", uniqueIpSet='" + getUniqueIpSet() + "'" +
                ", lockTimeout='" + getLockTimeout() + "'" +
                "}";
    }

}
