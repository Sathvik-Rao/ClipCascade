package com.acme.clipcascade.controller;

import java.security.Principal;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.annotation.AuthenticationPrincipal;

import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.model.ClipboardData;
import com.acme.clipcascade.model.UserPrincipal;
import com.acme.clipcascade.model.Users;
import com.acme.clipcascade.service.UserService;
import com.acme.clipcascade.utils.ResponseEntityUtil;

import jakarta.annotation.PostConstruct;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.transaction.Transactional;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.PutMapping;

@Controller
public class ClipCascadeController {

    private final ClipCascadeProperties clipCascadeProperties;
    private final UserService userService;
    private final SimpMessagingTemplate simpMessagingTemplate;

    public ClipCascadeController(
            ClipCascadeProperties clipCascadeProperties,
            UserService userService,
            SimpMessagingTemplate simpMessagingTemplate) {

        this.clipCascadeProperties = clipCascadeProperties;
        this.userService = userService;
        this.simpMessagingTemplate = simpMessagingTemplate;
    }

    @PostConstruct
    public void initializeDatabase() {
        // insert default user if empty
        userService.insertDefaultUserIfEmpty();
    }

    @GetMapping("/login")
    public String login() {
        return "login"; // login.html
    }

    @GetMapping("/logout")
    public String logout() {
        return "logout"; // logout.html
    }

    /**
     * Handles private messages sent to specific users over WebSocket.
     *
     * Clients send messages to "/app/cliptext" (application-level destination).
     * The server sends responses to "/user/{username}/queue/cliptext"
     * (user-specific queue).
     */
    @MessageMapping("/cliptext")
    public void sendPrivateMessage(
            Principal principal,
            ClipboardData clipboardData) {

        // Extract the custom UserPrincipal object from the Principal
        UserPrincipal userPrincipal = (UserPrincipal) ((UsernamePasswordAuthenticationToken) principal)
                .getPrincipal();

        // Prepare a message object with the received payload and type
        // Default type is "text" if none is specified
        ClipboardData messageToSend = new ClipboardData(
                clipboardData.getPayload(),
                (clipboardData.getType() == null) ? "text" : clipboardData.getType());

        /**
         * Send the message to the user's specific queue:
         * - Destination: "/user/{username}/queue/cliptext"
         * - Spring resolves the username using the Principal associated with the
         * session.
         * - Internally, Spring maps the WebSocket session ID to the username and routes
         * messages accordingly.
         * - By default username is the unique identifier for the user.
         */
        simpMessagingTemplate.convertAndSendToUser(
                userPrincipal.getUsername(),
                "/queue/cliptext",
                messageToSend);
    }

    @GetMapping("/health")
    public ResponseEntity<String> health() {
        return ResponseEntityUtil.executeWithResponse(() -> "OK");
    }

    @GetMapping("/csrf-token")
    public ResponseEntity<?> getCsrfToken(HttpServletRequest request) {
        // Get the CSRF token from the request
        return ResponseEntityUtil.executeWithResponse(
                () -> (CsrfToken) request.getAttribute("_csrf"));
    }

    @GetMapping("/max-size")
    public ResponseEntity<?> getMaxSizeAllowed() {
        return ResponseEntityUtil.executeWithResponse(
                () -> Collections.singletonMap("maxsize",
                        clipCascadeProperties.getMaxMessageSizeInBytes()));
    }

    @GetMapping("/max-message-size")
    public ResponseEntity<?> getMaxMessageSizeLimit() {
        return ResponseEntityUtil.executeWithResponse(
                () -> Collections.singletonMap("maxmessagesize",
                        clipCascadeProperties.getMaxMessageSizeInMiB()));
    }

    @GetMapping("/whoami")
    public ResponseEntity<?> whoami(@AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.executeWithResponse(() -> {
            Map<String, String> response = new HashMap<>();
            response.put("username", userPrincipal.getUsername());
            response.put("role", userPrincipal
                    .getAuthorities()
                    .stream()
                    .findFirst()
                    .map(GrantedAuthority::getAuthority)
                    .orElse(""));
            return response;
        });
    }

    @GetMapping("/admin/users")
    public ResponseEntity<?> getUsers(@AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.executeWithResponse(() -> userService.getAllUsers()),
                "Forbidden");
    }

    @DeleteMapping("/admin/delete-user")
    @Transactional
    public ResponseEntity<String> deleteUser(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.buildResponse(
                        userService.deleteUser(payload.get("username")),
                        "User deleted successfully",
                        "Invalid user or deletion failed"),
                "Forbidden");
    }

    @DeleteMapping("/admin/logout-user-session")
    public ResponseEntity<String> logoutUserSession(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.executeWithResponse(
                        () -> userService.logoutSessions(payload.get("username"))),
                "Forbidden");
    }

    @DeleteMapping("/logout-session")
    public ResponseEntity<String> logoutSession(
            @AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.executeWithResponse(
                () -> userService.logoutSessions(userPrincipal.getUsername()));
    }

    @PutMapping("/admin/update-user-role")
    @Transactional
    public ResponseEntity<String> updateUserRole(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.buildResponse(
                        userService.updateUserRole(payload.get("username"),
                                payload.get("role")) != null,
                        "User role updated successfully",
                        "Invalid user or role"),
                "Forbidden");
    }

    @PutMapping("/admin/toggle-user-status")
    @Transactional
    public ResponseEntity<String> toggleUserStatus(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> {
                    boolean enabled = Boolean.parseBoolean(payload.get("enabled"));
                    return ResponseEntityUtil.buildResponse(
                            userService.updateUserStatus(
                                    payload.get("username"),
                                    enabled) != null,
                            enabled ? "User enabled successfully"
                                    : "User disabled successfully",
                            "Invalid user or operation failed");
                },
                "Forbidden");
    }

    @PostMapping("/admin/register-user")
    @Transactional
    public ResponseEntity<String> registerNewUser(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Users user) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.buildResponse(
                        userService.registerUser(user) != null,
                        "User registered successfully",
                        "User already exists or invalid user"),
                "Forbidden");
    }

    @PutMapping("/update-password")
    @Transactional
    public ResponseEntity<String> updatePassword(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.buildResponse(
                userService.updatePassword(
                        userPrincipal.getUsername(),
                        payload.get("newPassword")) != null,
                "Password updated successfully",
                "Invalid user or password");
    }

    @PutMapping("/admin/update-user-password")
    @Transactional
    public ResponseEntity<String> updateUserPassword(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.buildResponse(
                        userService.updatePassword(
                                payload.get("username"),
                                payload.get("newPassword")) != null,
                        "Password updated successfully",
                        "Invalid user or password"),
                "Forbidden");
    }

    @PutMapping("/admin/update-username")
    @Transactional
    public ResponseEntity<String> updateUsername(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.buildResponse(
                        userService.updateUsername(
                                payload.get("oldUsername"),
                                payload.get("newUsername"),
                                userPrincipal.getUsername()) != null,
                        "Username updated successfully",
                        "Invalid user or username"),
                "Forbidden");
    }
}
