package com.acme.clipcascade.model;

import java.util.Collection;
import java.util.Collections;

import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.service.BruteForceProtectionService;

public class UserPrincipal implements UserDetails {

    private Users user;

    // transient: a Spring bean can't be serialized; null after a session is restored from disk
    private final transient BruteForceProtectionService bruteForceProtectionService;

    public UserPrincipal(
            Users user,
            BruteForceProtectionService bruteForceProtectionService) {

        this.user = user;
        this.bruteForceProtectionService = bruteForceProtectionService;
    }

    @Override
    public boolean isAccountNonLocked() {

        // restored session: already authenticated, the check only runs at login with a fresh principal
        if (bruteForceProtectionService == null) {
            return true;
        }

        // validate attempt using brute force protection
        return bruteForceProtectionService.recordAndValidateAttempt(user.getUsername());
    }

    @Override
    public boolean isEnabled() {
        return user.getEnabled();
    }

    @Override
    public String getPassword() {
        return user.getPassword();
    }

    @Override
    public String getUsername() {
        return user.getUsername();
    }

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        // Return a collection of roles
        return Collections.singleton(new SimpleGrantedAuthority(user.getRole()));
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
