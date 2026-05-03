package com.acme.clipcascade.model;

import java.io.Serializable;
import java.util.Collection;
import java.util.Collections;

import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.service.BruteForceProtectionService;

public class UserPrincipal implements UserDetails, Serializable {

    // Spring Session (JDBC store) serializes the SecurityContext, which holds
    // an Authentication whose principal is this UserPrincipal, so the class
    // must be Serializable.
    private static final long serialVersionUID = 1L;

    private Users user;

    // Spring-managed service bean: not Serializable and must not be persisted
    // alongside the user. Marked transient so it is skipped by the JDK
    // serializer; after deserialization the field is null and the null-guard
    // in isAccountNonLocked() takes over.
    private final transient BruteForceProtectionService bruteForceProtectionService;

    public UserPrincipal(
            Users user,
            BruteForceProtectionService bruteForceProtectionService) {

        this.user = user;
        this.bruteForceProtectionService = bruteForceProtectionService;
    }

    @Override
    public boolean isAccountNonLocked() {

        // When this principal was rehydrated from a persisted session the
        // transient service is null. Brute-force protection only needs to
        // gate the login flow itself; an already-authenticated session being
        // restored has cleared that gate previously, so skipping the check
        // here is safe. A fresh login request goes through MyUserDetailsService
        // and constructs a UserPrincipal that does have the service wired in.
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
