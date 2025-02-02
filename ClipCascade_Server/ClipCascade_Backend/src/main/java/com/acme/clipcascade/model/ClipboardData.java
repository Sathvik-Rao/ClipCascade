package com.acme.clipcascade.model;

import java.util.Map;

public class ClipboardData {
    private String payload;
    private String type;
    private Map<String, Object> metadata;

    public ClipboardData() {
    }

    public ClipboardData(String payload, String type, Map<String, Object> metadata) {
        this.payload = payload;
        this.type = type;
        this.metadata = metadata;
    }

    public String getPayload() {
        return this.payload;
    }

    public void setPayload(String payload) {
        this.payload = payload;
    }

    public String getType() {
        return this.type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public Map<String, Object> getMetadata() {
        return this.metadata;
    }

    public void setMetadata(Map<String, Object> metadata) {
        this.metadata = metadata;
    }

    @Override
    public String toString() {
        return "{" +
                " payload='" + getPayload() + "'" +
                ", type='" + getType() + "'" +
                ", metadata='" + getMetadata() + "'" +
                "}";
    }

}
