package com.acme.clipcascade.model;

import java.io.Serializable;

public class IpAttemptDetails implements Timeout, Serializable {
    private static final long serialVersionUID = 1L;

    private int attempts;
    private int lockCount;
    private long lockTimeout;

    public IpAttemptDetails() {
    }

    public IpAttemptDetails(int attempts, int lockCount, long lockTimeout) {
        this.attempts = attempts;
        this.lockCount = lockCount;
        this.lockTimeout = lockTimeout;
    }

    public int getAttempts() {
        return this.attempts;
    }

    public void setAttempts(int attempts) {
        this.attempts = attempts;
    }

    public int getLockCount() {
        return this.lockCount;
    }

    public void setLockCount(int lockCount) {
        this.lockCount = lockCount;
    }

    public long getLockTimeout() {
        return this.lockTimeout;
    }

    public void setLockTimeout(long lockTimeout) {
        this.lockTimeout = lockTimeout;
    }

    @Override
    public String toString() {
        return "{" +
                " attempts='" + getAttempts() + "'" +
                ", lockCount='" + getLockCount() + "'" +
                ", lockTimeout='" + getLockTimeout() + "'" +
                "}";
    }

}
