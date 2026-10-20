package com.acme.clipcascade.model;

import java.io.Serial;
import java.util.Collection;
import java.util.Collections;

import org.springframework.security.core.CredentialsContainer;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.service.BruteForceProtectionService;

public class UserPrincipal implements UserDetails, CredentialsContainer {

    @Serial
    private static final long serialVersionUID = 1L;

    private final String username;
    private final String role;
    private final boolean enabled;
    // Neither password hashes nor application services belong in persisted sessions.
    private transient String password;
    private final transient BruteForceProtectionService bruteForceProtectionService;

    public UserPrincipal(
            Users user,
            BruteForceProtectionService bruteForceProtectionService) {

        this.username = user.getUsername();
        this.role = user.getRole();
        this.enabled = user.getEnabled();
        this.password = user.getPassword();
        this.bruteForceProtectionService = bruteForceProtectionService;
    }

    @Override
    public boolean isAccountNonLocked() {

        // validate attempt using brute force protection
        return bruteForceProtectionService == null
                || bruteForceProtectionService.recordAndValidateAttempt(username);
    }

    @Override
    public boolean isEnabled() {
        return enabled;
    }

    @Override
    public String getPassword() {
        return password;
    }

    @Override
    public String getUsername() {
        return username;
    }

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        // Return a collection of roles
        return Collections.singleton(new SimpleGrantedAuthority(role));
    }

    @Override
    public void eraseCredentials() {
        this.password = null;
    }

    public boolean isAdmin() {
        return this.getAuthorities().stream()
                .anyMatch(authority -> authority.getAuthority()
                        .strip()
                        .equalsIgnoreCase(RoleConstants.ADMIN));
    }

    public boolean isUser() {
        return this.getAuthorities().stream()
                .anyMatch(authority -> authority.getAuthority()
                        .strip()
                        .equalsIgnoreCase(RoleConstants.USER));
    }
}
