package com.acme.clipcascade.service;

import java.util.Map;

import org.springframework.session.FindByIndexNameSessionRepository;
import org.springframework.session.Session;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.utils.UserValidator;

import jakarta.persistence.EntityNotFoundException;

@Service
public class SessionService {

    // SpringSessionBackedSessionRegistry.getAllPrincipals() throws
    // UnsupportedOperationException because Spring Session does not expose a
    // way to enumerate every principal across the store. The previous
    // implementation, which scanned that list and filtered by username,
    // therefore broke every "log out user X" code path (admin force-logoff,
    // self "Logoff from All Devices", username/password change, user delete).
    //
    // Looking sessions up by indexed principal name and deleting them
    // directly preserves the original semantics — the client cookie is
    // invalidated — while also being O(n) only in the user's own sessions.

    private final FindByIndexNameSessionRepository<? extends Session> sessionRepository;
    private final UserService userService;

    public SessionService(
            FindByIndexNameSessionRepository<? extends Session> sessionRepository,
            UserService userService) {

        this.sessionRepository = sessionRepository;
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

        // Indexed lookup against the SPRING_SESSION.PRINCIPAL_NAME column.
        Map<String, ? extends Session> sessions = sessionRepository.findByPrincipalName(username);

        if (sessions.isEmpty()) {
            return "No active sessions found for username: " + username;
        }

        // Deleting the session row immediately invalidates the client cookie.
        for (String sessionId : sessions.keySet()) {
            sessionRepository.deleteById(sessionId);
        }

        return "User '" + username + "' has been logged out of all active sessions.";
    }
}
