package com.acme.clipcascade.service;

import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.lang.Nullable;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.config.P2PWebSocketHandler;
import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.model.IpAttemptDetails;
import com.acme.clipcascade.model.UserInfo;
import com.acme.clipcascade.model.Users;
import com.acme.clipcascade.utils.IpAddressResolver;
import com.acme.clipcascade.utils.TimeUtility;
import com.acme.clipcascade.utils.UserValidator;

@Service
public class FacadeUserService {

    private final UserService userService;
    private final UserInfoService userInfoService;
    private final ClipCascadeProperties clipCascadeProperties;
    private final P2PWebSocketHandler p2pWebSocketHandler;

    public FacadeUserService(
            UserService userService,
            UserInfoService userInfoService,
            ClipCascadeProperties clipCascadeProperties,
            @Nullable P2PWebSocketHandler p2pWebSocketHandler) {

        this.userService = userService;
        this.userInfoService = userInfoService;
        this.clipCascadeProperties = clipCascadeProperties;
        this.p2pWebSocketHandler = p2pWebSocketHandler;
    }

    public void insertDefaultAdminUserIfEmpty() {
        if (userService.isTableEmpty()) {
            if (!clipCascadeProperties.isInitialAdminPasswordConfigured()) {
                throw new IllegalStateException(
                        "Empty user database. Set CC_INITIAL_ADMIN_PASSWORD before first startup.");
            }
            if (!UserValidator.isValidPassword(clipCascadeProperties.getInitialAdminPassword())) {
                throw new IllegalStateException("CC_INITIAL_ADMIN_PASSWORD is too weak.");
            }

            String initialAdminUsername = clipCascadeProperties.getInitialAdminUsername();
            if (!UserValidator.isValidUsername(initialAdminUsername)) {
                throw new IllegalStateException("CC_INITIAL_ADMIN_USERNAME is invalid.");
            }

            userService.doubleHashAndCreateUser(
                    initialAdminUsername,
                    clipCascadeProperties.getInitialAdminPassword(),
                    RoleConstants.ADMIN,
                    true);

            userInfoService.registerNewUser(initialAdminUsername);
        }
    }

    public Users registerUser(Users user) {
        if (!UserValidator.isValid(user)
                || userService.userExists(user.getUsername())
                || userInfoService.userExists(user.getUsername())) {

            return null;
        }

        long maxUserAccounts = clipCascadeProperties.getMaxUserAccounts();
        if (maxUserAccounts != -1
                && userService.countUsers() >= maxUserAccounts) {
            return null;
        }

        userInfoService.registerNewUser(user.getUsername());

        return userService.registerUser(user);
    }

    public Users updateUsername(
            String oldUsername,
            String newUsername,
            String principalUsername,
            SessionService sessionService) {

        if (!UserValidator.isValidUsername(oldUsername)
                || !UserValidator.isValidUsername(newUsername)
                || userService.userExists(newUsername)
                || userInfoService.userExists(newUsername)) {

            return null;
        }

        revokeSessions(oldUsername, sessionService);

        UserInfo userInfo = userInfoService.markUserForDeletion(oldUsername);
        if (userInfo == null) {
            userInfoService.registerNewUser(newUsername);
        } else {
            userInfo.setUsername(newUsername);
            userInfoService.registerNewUser(userInfo);
        }

        return userService.updateUsername(oldUsername, newUsername);
    }

    public boolean deleteUser(String username, SessionService sessionService) {
        if (!UserValidator.isValidUsername(username)
                || !userService.userExists(username)) {

            return false;
        }

        revokeSessions(username, sessionService);

        userInfoService.markUserForDeletion(username);

        return userService.deleteUser(username);
    }

    public Users updatePassword(String username, String newPassword, SessionService sessionService) {
        if (!UserValidator.isValidUsername(username)
                || !UserValidator.isValidPassword(newPassword)) {

            return null;
        }

        userInfoService.setPasswordChangeTime(username, TimeUtility.getCurrentTimeInSeconds());

        Users updatedUser = userService.updatePassword(username, newPassword);
        if (updatedUser != null) {
            revokeSessions(username, sessionService);
        }

        return updatedUser;
    }

    public Users updateOwnPassword(
            String username,
            String currentPassword,
            String newPassword,
            SessionService sessionService) {

        if (!userService.passwordMatches(username, currentPassword)) {
            return null;
        }

        return updatePassword(username, newPassword, sessionService);
    }

    public Users updateUserStatus(
            String username,
            boolean enable,
            SessionService sessionService) {

        if (!UserValidator.isValidUsername(username)
                || !userService.userExists(username)) {

            return null;
        }

        revokeSessions(username, sessionService);

        return userService.updateUserStatus(username, enable);
    }

    public UserInfo setLoginDetails(String username, IpAttemptDetails ipDetails) {
        int lockCount = ipDetails.getLockCount();
        if (ipDetails.getAttempts() == 0) {
            lockCount -= 1;
        }
        String lockoutTime = TimeUtility.convertSecondsToString(
                clipCascadeProperties.getLockTimeoutSeconds()
                        * (lockCount * clipCascadeProperties.getLockTimeoutScalingFactor()));

        return userInfoService.setLoginDetails(
                username,
                IpAddressResolver.getUserIpAddress(),
                TimeUtility.getCurrentTimeInSeconds(),
                (ipDetails.getAttempts() + (ipDetails.getLockCount() * clipCascadeProperties.getMaxAttemptsPerIp()))
                        - 1,
                lockoutTime);
    }

    public void deleteInactiveUsers(SessionService sessionService, Set<Users> excludedUsers) {
        if (clipCascadeProperties.getAccountPurgeTimeoutSeconds() < 0) {
            return;
        }

        Set<String> inactiveUsers = userInfoService.getInactiveUsers(
                clipCascadeProperties.getAccountPurgeTimeoutSeconds());

        // Remove excluded users from inactiveUsers
        Set<String> excludedUserIds = excludedUsers.stream()
                .map(Users::getUsername)
                .collect(Collectors.toSet());
        inactiveUsers.removeAll(excludedUserIds);

        for (String inactiveUser : inactiveUsers) {
            deleteUser(inactiveUser, sessionService);
        }
    }

    private void revokeSessions(String username, SessionService sessionService) {
        sessionService.logoutAllSessions(username);
        if (p2pWebSocketHandler != null) {
            p2pWebSocketHandler.closeSessionsForUser(username);
        }
    }
}
