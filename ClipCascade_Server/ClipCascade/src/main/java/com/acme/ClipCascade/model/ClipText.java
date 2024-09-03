package com.acme.ClipCascade.model;

public class ClipText {
    private String text;

    public ClipText() {
    }

    public ClipText(String text) {
        this.text = text;
    }

    public String getText() {
        return this.text;
    }

    public void setText(String text) {
        this.text = text;
    }

    @Override
    public String toString() {
        return "{" +
                " text='" + getText() + "'" +
                "}";
    }

}
