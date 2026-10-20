package com.acme.clipcascade.service;

import java.util.List;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.session.jdbc.JdbcIndexedSessionRepository;

import org.springframework.security.core.session.SessionInformation;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.stereotype.Service;

import org.springframework.security.core.userdetails.UserDetails;
import com.acme.clipcascade.utils.UserValidator;

import jakarta.persistence.EntityNotFoundException;

@Service
public class SessionService {
    private final SessionRegistry sessionRegistry;
    private final UserService userService;
    private final JdbcIndexedSessionRepository persistentSessions;
    private final JdbcTemplate jdbc;
    private final LiveWebSocketService liveWebSockets;

    public SessionService(
            SessionRegistry sessionRegistry,
            UserService userService,
            ObjectProvider<JdbcIndexedSessionRepository> repositories,
            JdbcTemplate jdbc, LiveWebSocketService liveWebSockets) {

        this.sessionRegistry = sessionRegistry;
        this.userService = userService;
        this.persistentSessions = repositories.getIfAvailable();
        this.jdbc = jdbc;
        this.liveWebSockets = liveWebSockets;
    }

    public String logoutAllUsers() {
        if (persistentSessions != null) {
            // Includes anonymous sessions and the administrator making the request.
            jdbc.update("DELETE FROM SPRING_SESSION");
        } else {
            for (Object principal : sessionRegistry.getAllPrincipals()) {
                sessionRegistry.getAllSessions(principal, false).forEach(SessionInformation::expireNow);
            }
        }
        liveWebSockets.disconnectAll();
        return "All users have been logged out of all active sessions.";
    }

    // logout all sessions for a specific user/username
    public String logoutAllSessions(String username) {
        if (!UserValidator.isValidUsername(username)) {
            throw new IllegalArgumentException("Invalid username");
        }

        // Check if user exists
        if (!userService.userExists(username)) {
            throw new EntityNotFoundException("User not found");
        }

        if (persistentSessions != null) {
            var sessions = persistentSessions.findByPrincipalName(username);
            sessions.keySet().forEach(persistentSessions::deleteById);
            liveWebSockets.disconnectUser(username);
            return sessions.isEmpty() ? "No active sessions found for username: " + username
                    : "User '" + username + "' has been logged out of all active sessions.";
        }

        // Iterate over all principals in the SessionRegistry
        List<Object> principals = sessionRegistry.getAllPrincipals();
        boolean foundUser = false;

        for (Object principal : principals) {
            if (principal instanceof UserDetails userDetails) { // <- Spring Security UserDetails
                if (userDetails.getUsername().equals(username)) {
                    foundUser = true;
                    // Get all active sessions for this principal
                    List<SessionInformation> sessions = sessionRegistry.getAllSessions(principal, false);
                    // Expire each session to effectively force logout
                    for (SessionInformation sessionInfo : sessions) {
                        sessionInfo.expireNow(); // mark it as expired
                    }
                }
            }
        }

        liveWebSockets.disconnectUser(username);

        if (!foundUser) {
            return "No active sessions found for username: " + username;
        }

        return "User '" + username + "' has been logged out of all active sessions.";
    }
}
