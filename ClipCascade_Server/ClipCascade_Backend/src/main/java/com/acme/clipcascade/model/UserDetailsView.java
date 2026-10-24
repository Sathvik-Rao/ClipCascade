package com.acme.clipcascade.model;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

/**
 * Flat view of a UserInfo row plus the matching Users.enabled flag.
 * Used by the admin user-details listing so the UI can show
 * enabled/disabled status without a second request.
 */
public class UserDetailsView {

    @JsonUnwrapped
    private UserInfo info;

    private Boolean enabled;

    public UserDetailsView() {
    }

    public UserDetailsView(UserInfo info, Boolean enabled) {
        this.info = info;
        this.enabled = enabled;
    }

    public UserInfo getInfo() {
        return info;
    }

    public void setInfo(UserInfo info) {
        this.info = info;
    }

    public Boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(Boolean enabled) {
        this.enabled = enabled;
    }
}
