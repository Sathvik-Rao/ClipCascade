package com.acme.clipcascade.service;

import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;

import com.acme.clipcascade.config.ClipCascadeProperties;
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

    public FacadeUserService(
            UserService userService,
            UserInfoService userInfoService,
            ClipCascadeProperties clipCascadeProperties) {

        this.userService = userService;
        this.userInfoService = userInfoService;
        this.clipCascadeProperties = clipCascadeProperties;
    }

    public void insertDefaultAdminUserIfEmpty() {
        if (userService.isTableEmpty()) {
            userService.doubleHashAndCreateUser(
                    "admin",
                    "admin123",
                    RoleConstants.ADMIN,
                    true);

            userInfoService.registerNewUser("admin");
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

        sessionService.logoutAllSessions(oldUsername);

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

        sessionService.logoutAllSessions(username);

        userInfoService.markUserForDeletion(username);

        return userService.deleteUser(username);
    }

    public Users updatePassword(String username, String newPassword) {
        if (!UserValidator.isValidUsername(username)
                || !UserValidator.isValidPassword(newPassword)) {

            return null;
        }

        userInfoService.setPasswordChangeTime(username, TimeUtility.getCurrentTimeInSeconds());

        return userService.updatePassword(username, newPassword);
    }

    public Users updateUserStatus(
            String username,
            boolean enable,
            SessionService sessionService) {

        if (!UserValidator.isValidUsername(username)
                || !userService.userExists(username)) {

            return null;
        }

        sessionService.logoutAllSessions(username);

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
}
