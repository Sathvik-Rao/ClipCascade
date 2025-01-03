package com.acme.clipcascade.model;

public class ClipboardData {
    private String payload;
    private String type;

    public ClipboardData() {
    }

    public ClipboardData(String payload, String type) {
        this.payload = payload;
        this.type = type;
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

    @Override
    public String toString() {
        return "{" +
                " payload='" + getPayload() + "'" +
                ", type='" + getType() + "'" +
                "}";
    }

}
