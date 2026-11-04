package com.acme.clipcascade.config;

import java.io.IOException;

import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.web.filter.OncePerRequestFilter;

import com.acme.clipcascade.model.UserPrincipal;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Trusted-header (reverse-proxy / SSO) authentication for the web panel.
 *
 * When enabled (CC_TRUSTED_HEADER_AUTH, default false), a request carrying
 * the username in the header named by CC_TRUSTED_HEADER_NAME (default
 * X-Remote-User) is authenticated as that user without the login form. This
 * is the standard self-hosted SSO pattern: an authenticating reverse proxy
 * (Authelia, oauth2-proxy, a CDN worker, ...) verifies identity, STRIPS any
 * client-supplied copy of the header, and injects its own.
 *
 * ONLY enable this when the server is reachable exclusively through such a
 * proxy — with the port exposed directly, a spoofed header is a full
 * authentication bypass.
 *
 * Deliberately conservative:
 * - Native-client paths (/login, /logout, /clipsocket, /p2psignaling) are
 *   never touched; clients keep username/password + session auth unchanged.
 * - Emits the same UsernamePasswordAuthenticationToken/UserPrincipal pair as
 *   form login, so downstream code (STOMP principal, isAdmin() checks,
 *   /whoami) behaves identically.
 * - Checks isEnabled() only — never isAccountNonLocked(), which feeds the
 *   brute-force tracker and would count SSO requests as failed attempts.
 * - Persists the context to the session, so the lookup runs once per
 *   session, not per request.
 * - An unknown or disabled user falls through to the normal login flow.
 */
public class TrustedHeaderAuthenticationFilter extends OncePerRequestFilter {

    private final ClipCascadeProperties clipCascadeProperties;
    private final UserDetailsService userDetailsService;
    private final SecurityContextRepository securityContextRepository = new HttpSessionSecurityContextRepository();

    public TrustedHeaderAuthenticationFilter(
            ClipCascadeProperties clipCascadeProperties,
            UserDetailsService userDetailsService) {
        this.clipCascadeProperties = clipCascadeProperties;
        this.userDetailsService = userDetailsService;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!clipCascadeProperties.isTrustedHeaderAuth()) {
            return true;
        }
        String path = request.getServletPath();
        return path.equals("/login")
                || path.equals("/logout")
                || path.equals("/clipsocket") || path.startsWith("/clipsocket/")
                || path.equals("/p2psignaling") || path.startsWith("/p2psignaling/");
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain) throws ServletException, IOException {

        Authentication existing = SecurityContextHolder.getContext().getAuthentication();
        if (existing != null && existing.isAuthenticated()
                && !(existing instanceof AnonymousAuthenticationToken)) {
            filterChain.doFilter(request, response); // already authenticated (session)
            return;
        }

        String username = request.getHeader(clipCascadeProperties.getTrustedHeaderName());
        if (username == null || username.isBlank()) {
            filterChain.doFilter(request, response);
            return;
        }

        try {
            UserPrincipal principal = (UserPrincipal) userDetailsService
                    .loadUserByUsername(username.trim());
            if (principal.isEnabled()) {
                UsernamePasswordAuthenticationToken authentication = new UsernamePasswordAuthenticationToken(
                        principal, null, principal.getAuthorities());
                SecurityContext context = SecurityContextHolder.createEmptyContext();
                context.setAuthentication(authentication);
                SecurityContextHolder.setContext(context);
                securityContextRepository.saveContext(context, request, response);
            }
        } catch (UsernameNotFoundException e) {
            // unknown user -> fall through to the normal login flow
        }

        filterChain.doFilter(request, response);
    }
}
