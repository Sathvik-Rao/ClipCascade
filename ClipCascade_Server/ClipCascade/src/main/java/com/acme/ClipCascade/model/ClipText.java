package com.acme.ClipCascade.model;

public class ClipText {
    private String text;
    private String type;

    public ClipText() {
    }

    public ClipText(String text, String type) {
        this.text = text;
        this.type = type;
    }

    public String getText() {
        return this.text;
    }

    public void setText(String text) {
        this.text = text;
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
                " text='" + getText() + "'" +
                ", type='" + getType() + "'" +
                "}";
    }

}
