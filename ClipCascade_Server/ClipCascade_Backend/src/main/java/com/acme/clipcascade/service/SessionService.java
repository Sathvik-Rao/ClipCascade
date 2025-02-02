package com.acme.clipcascade.service;

import java.util.List;

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

    public SessionService(
            SessionRegistry sessionRegistry,
            UserService userService) {

        this.sessionRegistry = sessionRegistry;
        this.userService = userService;
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

        if (!foundUser) {
            return "No active sessions found for username: " + username;
        }

        return "User '" + username + "' has been logged out of all active sessions.";
    }
}
