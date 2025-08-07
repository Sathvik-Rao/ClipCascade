package com.acme.clipcascade.controller;

import java.io.IOException;
import java.security.Principal;
import java.util.Collections;
import java.awt.image.BufferedImage;
import java.util.HashMap;
import java.util.Map;

import javax.imageio.ImageIO;

import org.springframework.http.ResponseEntity;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.annotation.AuthenticationPrincipal;

import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.constants.ServerConstants;
import com.acme.clipcascade.model.ClipboardData;
import com.acme.clipcascade.model.UserPrincipal;
import com.acme.clipcascade.model.Users;
import com.acme.clipcascade.service.BruteForceProtectionService;
import com.acme.clipcascade.service.CaptchaService;
import com.acme.clipcascade.service.DonationService;
import com.acme.clipcascade.service.FacadeUserService;
import com.acme.clipcascade.service.SessionService;
import com.acme.clipcascade.service.UserInfoService;
import com.acme.clipcascade.service.UserService;
import com.acme.clipcascade.service.WebSocketStatsService;
import com.acme.clipcascade.utils.ResponseEntityUtil;
import com.acme.clipcascade.utils.TimeUtility;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import jakarta.annotation.Nullable;
import jakarta.annotation.PostConstruct;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import jakarta.transaction.Transactional;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseBody;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.bind.annotation.PutMapping;

@Controller
public class ClipCascadeController {

    private final ClipCascadeProperties clipCascadeProperties;
    private final UserService userService;
    private final UserInfoService userInfoService;
    private final SessionService sessionService;
    private final FacadeUserService facadeUserService;
    private final SimpMessagingTemplate simpMessagingTemplate;
    private final CaptchaService captchaService;
    private final BruteForceProtectionService bruteForceProtectionService;
    private final WebSocketStatsService webSocketStatsService;
    private final DonationService donationService;

    public ClipCascadeController(
            ClipCascadeProperties clipCascadeProperties,
            FacadeUserService facadeUserService,
            UserService userService,
            @Nullable SimpMessagingTemplate simpMessagingTemplate,
            CaptchaService captchaService,
            UserInfoService userInfoService,
            SessionService sessionService,
            BruteForceProtectionService bruteForceProtectionService,
            WebSocketStatsService webSocketStatsService,
            DonationService donationService) {

        this.clipCascadeProperties = clipCascadeProperties;
        this.facadeUserService = facadeUserService;
        this.userService = userService;
        this.simpMessagingTemplate = simpMessagingTemplate;
        this.captchaService = captchaService;
        this.userInfoService = userInfoService;
        this.sessionService = sessionService;
        this.bruteForceProtectionService = bruteForceProtectionService;
        this.webSocketStatsService = webSocketStatsService;
        this.donationService = donationService;
    }

    @PostConstruct
    @Transactional
    public void initializeDatabase() {
        // insert default admin user if table is empty
        facadeUserService.insertDefaultAdminUserIfEmpty();

        // make sure only one admin user exists
        Users adminUser = userService.verifyAdminExistence();

        // delete inactive users except admin
        facadeUserService.deleteInactiveUsers(sessionService, Collections.singleton(adminUser));

        // delete users which are marked for deletion
        userInfoService.purgeDeletedUsers();

        // initialize donation url
        donationService.initializeDonationUrl();
    }

    @GetMapping("/login")
    public String login(Model model) {
        model.addAttribute("signupEnabled", clipCascadeProperties.isSignupEnabled());
        model.addAttribute("donationsEnabled", clipCascadeProperties.isDonationsEnabled());
        return "login"; // login.html
    }

    @GetMapping("/signup")
    public String signup() {
        if (clipCascadeProperties.isSignupEnabled()) {
            return "signup"; // signup.html
        } else {
            return "redirect:/"; // Redirect to the home page
        }
    }

    @GetMapping("/help")
    public String help() {
        return "redirect:" + ServerConstants.HELP_URL;
    }

    @GetMapping("/donate")
    public String donate() {
        if (clipCascadeProperties.isDonationsEnabled()) {
            return "redirect:" + donationService.getDonationUrl();
        } else {
            return "redirect:/";
        }
    }

    @GetMapping("/logout")
    public String logout() {
        return "logout"; // logout.html
    }

    @GetMapping("/admin/advance")
    public String advance(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            Model model) {

        if (userPrincipal.isAdmin()) {
            model.addAttribute("envVariables", clipCascadeProperties);
            return "advance"; // advance.html
        } else {
            return "redirect:/"; // Redirect to the home page
        }
    }

    /**
     * Handles private messages sent to specific users over WebSocket.
     *
     * Clients send messages to "/app/cliptext" (application-level destination).
     * The server sends responses to "/user/{sessionId}/queue/cliptext"
     * (user-specific queue).
     */
    @MessageMapping("/cliptext")
    public void sendPrivateMessage(
            Principal principal,
            ClipboardData clipboardData) {

        if (clipCascadeProperties.isP2pEnabled()) {
            return;
        }

        // Extract the custom UserPrincipal object from the Principal
        UserPrincipal userPrincipal = (UserPrincipal) ((UsernamePasswordAuthenticationToken) principal)
                .getPrincipal();

        // Prepare a message object with the received payload, type and metadata
        // Default type is "text" if none is specified
        ClipboardData messageToSend = new ClipboardData(
                clipboardData.getPayload(),
                (clipboardData.getType() == null) ? "text" : clipboardData.getType(),
                clipboardData.getMetadata());

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

    @GetMapping("/captcha")
    public void getCaptcha(
            HttpServletResponse response,
            HttpSession session) throws IOException {

        if (!clipCascadeProperties.isSignupEnabled())
            return;

        // Generate captcha and store answer in session
        BufferedImage captchaImage = captchaService.generateCaptcha(
                200,
                50,
                5,
                6,
                session,
                ServerConstants.CAPTCHA_SESSION_ID,
                ServerConstants.CAPTCHA_CASE_SENSITIVE);

        // Set the response headers
        response.setContentType("image/png");

        // Write the image to the response output stream
        ImageIO.write(captchaImage, "PNG", response.getOutputStream());
    }

    @GetMapping("/health")
    public ResponseEntity<String> health() {
        return ResponseEntityUtil.executeWithResponse(() -> "OK");
    }

    @GetMapping("/ping")
    public ResponseEntity<?> ping() {
        return ResponseEntityUtil.executeWithResponse(() -> "pong");
    }

    @GetMapping("/donation-status")
    public ResponseEntity<?> getDonationStatus() {
        return ResponseEntityUtil.executeWithResponse(() -> {
            if (clipCascadeProperties.isDonationsEnabled()) {
                return Collections.singletonMap("enabled", true);
            } else {
                return Collections.singletonMap("enabled", false);
            }
        });
    }

    @GetMapping("/server-mode")
    public ResponseEntity<?> serverMode() {
        return ResponseEntityUtil.executeWithResponse(() -> {
            if (clipCascadeProperties.isP2pEnabled()) {
                return Collections.singletonMap("mode", "P2P");
            } else {
                return Collections.singletonMap("mode", "P2S");
            }
        });
    }

    @GetMapping("/stun-url")
    public ResponseEntity<?> getStunUrl() {
        return ResponseEntityUtil.executeWithResponse(() -> {
            if (clipCascadeProperties.isP2pEnabled()) {
                return Collections.singletonMap("url", clipCascadeProperties.getP2pStunUrl());
            } else {
                return Collections.singletonMap("url", "");
            }
        });
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

    @GetMapping("/validate-session")
    public ResponseEntity<?> validateSession() {
        return ResponseEntityUtil.executeWithResponse(() -> "OK");
    }

    @GetMapping("/admin/server-version")
    public ResponseEntity<?> getServerVersion(
            @AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.executeWithResponse(
                        () -> Collections.singletonMap("version", ServerConstants.APP_VERSION)),
                "Forbidden");
    }

    @GetMapping("/admin/latest-server-version")
    public ResponseEntity<?> getLatestServerVersion(
            @AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.executeWithResponse(
                        () -> {
                            try {
                                // get latest version
                                RestTemplate restTemplate = new RestTemplate();
                                String versionJson = restTemplate.getForObject(
                                        ServerConstants.VERSION_URL,
                                        String.class);

                                // convert json string to map
                                ObjectMapper objectMapper = new ObjectMapper();
                                return objectMapper.readValue(versionJson, Map.class);
                            } catch (Exception e) {
                                throw new RuntimeException(e);
                            }
                        }),
                "Forbidden");
    }

    @GetMapping("/admin/websocket-stats")
    public ResponseEntity<?> getWebSocketStats(
            @AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil
                        .executeWithResponse(() -> webSocketStatsService.getWebSocketStats()),
                "Forbidden");
    }

    @GetMapping("/admin/all-users")
    public ResponseEntity<?> getAllUsers(@AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.executeWithResponse(() -> userService.getAllUsers()),
                "Forbidden");
    }

    @GetMapping("/admin/users")
    public ResponseEntity<?> getUsers(@AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil
                        .executeWithResponse(() -> userService.getUsers(RoleConstants.USER)),
                "Forbidden");
    }

    @GetMapping("/admin/user-details")
    public ResponseEntity<?> getUserDetails(@AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.executeWithResponse(
                        () -> userInfoService.getAllUserDetails()),
                "Forbidden");
    }

    @GetMapping("/admin/bfa-snapshot-file")
    @ResponseBody
    public byte[] getBfaSnapshotFile(
            @AuthenticationPrincipal UserPrincipal userPrincipal) throws JsonProcessingException {

        if (!userPrincipal.isAdmin()) {
            return null;
        }

        return bruteForceProtectionService.getTrackerFile();
    }

    @GetMapping("/admin/bfa-snapshot")
    public ResponseEntity<?> getBfaSnapshot(@AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.executeWithResponse(
                        () -> bruteForceProtectionService.getTracker()),
                "Forbidden");
    }

    @GetMapping("/admin/server-time")
    public ResponseEntity<?> getServerTime(
            @AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.executeWithResponse(
                        () -> "Epoch time: " + TimeUtility.getCurrentTimeInSeconds()),
                "Forbidden");
    }

    @PostMapping("/signup")
    @Transactional
    public ResponseEntity<String> signup(
            HttpSession session,
            String username,
            String password,
            String captchaInput) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                clipCascadeProperties.isSignupEnabled(),
                () ->

                ResponseEntityUtil.conditionalExecuteOrError(
                        captchaService.validateCaptcha(
                                captchaInput,
                                ServerConstants.CAPTCHA_CASE_SENSITIVE,
                                session,
                                ServerConstants.CAPTCHA_SESSION_ID),
                        () ->

                        ResponseEntityUtil.buildResponse(
                                facadeUserService.registerUser(
                                        new Users(
                                                username,
                                                password,
                                                RoleConstants.USER)) != null,
                                "User registered successfully",
                                "Invalid user or password")

                        ,
                        "Captcha validation failed")

                ,
                "Signup is disabled");
    }

    @DeleteMapping("/admin/delete-user")
    @Transactional
    public ResponseEntity<String> deleteUser(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.conditionalExecuteOrError(
                        userService.isNonAdminUser(payload.get("username")),
                        () -> ResponseEntityUtil.buildResponse(
                                facadeUserService.deleteUser(payload.get("username"),
                                        sessionService),
                                "User deleted successfully",
                                "Invalid user or deletion failed"),
                        "admin user cannot be deleted"),
                "Forbidden");
    }

    @DeleteMapping("/admin/logout-user-session")
    public ResponseEntity<String> logoutUserSession(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.executeWithResponse(
                        () -> sessionService.logoutAllSessions(payload.get("username"))),
                "Forbidden");
    }

    @DeleteMapping("/logout-session")
    public ResponseEntity<String> logoutSession(
            @AuthenticationPrincipal UserPrincipal userPrincipal) {

        return ResponseEntityUtil.executeWithResponse(
                () -> sessionService.logoutAllSessions(userPrincipal.getUsername()));
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
                            facadeUserService.updateUserStatus(
                                    payload.get("username"),
                                    enabled,
                                    sessionService) != null,
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
                () -> ResponseEntityUtil.conditionalExecuteOrError(
                        !user.getRole().equals(RoleConstants.ADMIN),
                        () -> ResponseEntityUtil.buildResponse(
                                facadeUserService.registerUser(user) != null,
                                "User registered successfully",
                                "User already exists or invalid user"),
                        "Role must be user"),
                "Forbidden");
    }

    @PutMapping("/update-password")
    @Transactional
    public ResponseEntity<String> updatePassword(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.buildResponse(
                facadeUserService.updatePassword(
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
                        facadeUserService.updatePassword(
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
                        facadeUserService.updateUsername(
                                payload.get("oldUsername"),
                                payload.get("newUsername"),
                                userPrincipal.getUsername(),
                                sessionService) != null,
                        "Username updated successfully",
                        "Invalid user or username"),
                "Forbidden");
    }

    @PutMapping("/admin/unlock-user")
    @Transactional
    public ResponseEntity<String> unlockUser(
            @AuthenticationPrincipal UserPrincipal userPrincipal,
            @RequestBody Map<String, String> payload) {

        return ResponseEntityUtil.conditionalExecuteOrError(
                userPrincipal.isAdmin(),
                () -> ResponseEntityUtil.buildResponse(
                        bruteForceProtectionService
                                .unlockUser(payload.get("username")) != null,
                        "User unlocked successfully",
                        "Invalid user or operation failed"),
                "Forbidden");
    }

}
