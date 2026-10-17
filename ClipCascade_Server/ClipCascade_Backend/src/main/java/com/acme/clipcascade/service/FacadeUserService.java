package com.acme.clipcascade.service;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.model.IpAttemptDetails;
import com.acme.clipcascade.model.PageResponse;
import com.acme.clipcascade.model.UserDetailsView;
import com.acme.clipcascade.model.UserInfo;
import com.acme.clipcascade.model.Users;
import com.acme.clipcascade.utils.IpAddressResolver;
import com.acme.clipcascade.utils.PagingUtility;
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
        // ipDetails can be null when this IP has no prior failed attempts on
        // record (e.g. first login from a fresh IP, or after the tracker was
        // pruned). Treat that case as zero attempts so we still record a clean
        // login row instead of NPE'ing.
        int attempts = ipDetails == null ? 0 : ipDetails.getAttempts();
        int rawLockCount = ipDetails == null ? 0 : ipDetails.getLockCount();
        int lockCount = rawLockCount;
        if (attempts == 0) {
            lockCount -= 1;
        }
        String lockoutTime = TimeUtility.convertSecondsToString(
                clipCascadeProperties.getLockTimeoutSeconds()
                        * (lockCount * clipCascadeProperties.getLockTimeoutScalingFactor()));

        return userInfoService.setLoginDetails(
                username,
                IpAddressResolver.getUserIpAddress(),
                TimeUtility.getCurrentTimeInSeconds(),
                (attempts + (rawLockCount * clipCascadeProperties.getMaxAttemptsPerIp())) - 1,
                lockoutTime);
    }

    private static Comparator<UserDetailsView> byInfo(
            Comparator<UserInfo> infoComparator) {

        return Comparator.comparing(UserDetailsView::getInfo,
                Comparator.nullsLast(infoComparator));
    }

    private static final Map<String, Comparator<UserDetailsView>> USER_DETAILS_COMPARATORS = Map.ofEntries(
            Map.entry("username", byInfo(Comparator.comparing(UserInfo::getUsername,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))),
            Map.entry("enabled", Comparator.comparing(UserDetailsView::getEnabled,
                    Comparator.nullsLast(Boolean::compare))),
            Map.entry("markedForDeletion", byInfo(Comparator.comparing(UserInfo::isMarkedForDeletion))),
            Map.entry("firstSignup", byInfo(Comparator.comparing(UserInfo::getFirstSignup,
                    Comparator.nullsLast(Long::compare)))),
            Map.entry("lastLogin", byInfo(Comparator.comparing(UserInfo::getLastLogin,
                    Comparator.nullsLast(Long::compare)))),
            Map.entry("firstSignupIp", byInfo(Comparator.comparing(UserInfo::getFirstSignupIp,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))),
            Map.entry("lastLoginIp", byInfo(Comparator.comparing(UserInfo::getLastLoginIp,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))),
            Map.entry("failedLoginAttempts", byInfo(Comparator.comparing(UserInfo::getFailedLoginAttempts))),
            Map.entry("lockoutTime", byInfo(Comparator.comparing(UserInfo::getLockoutTime,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))),
            Map.entry("passwordChangedAt", byInfo(Comparator.comparing(UserInfo::getPasswordChangedAt,
                    Comparator.nullsLast(Long::compare)))),
            Map.entry("email", byInfo(Comparator.comparing(UserInfo::getEmail,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))),
            Map.entry("otp", byInfo(Comparator.comparing(UserInfo::getOtp,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))),
            Map.entry("phone", byInfo(Comparator.comparing(UserInfo::getPhone,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))),
            Map.entry("firstName", byInfo(Comparator.comparing(UserInfo::getFirstName,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))),
            Map.entry("lastName", byInfo(Comparator.comparing(UserInfo::getLastName,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))),
            Map.entry("notes", byInfo(Comparator.comparing(UserInfo::getNotes,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))));

    /**
     * Backend-driven, joined view for the admin "User Details" table.
     * Combines UserInfo rows with Users.enabled and runs search/sort/paginate
     * server-side so the UI just renders one page at a time.
     */
    public PageResponse<UserDetailsView> getUserDetailsPage(
            int page,
            int size,
            String sort,
            String direction,
            String search) {

        List<UserInfo> infos = userInfoService.getAllUserDetails();
        Map<String, Boolean> enabledMap = userService.getAllUsers().stream()
                .collect(Collectors.toMap(Users::getUsername, Users::getEnabled,
                        (a, b) -> a));

        List<UserDetailsView> views = infos.stream()
                .map(info -> new UserDetailsView(info, enabledMap.get(info.getUsername())))
                .collect(Collectors.toList());

        String needle = (search == null) ? "" : search.trim().toLowerCase();
        Predicate<UserDetailsView> filter = needle.isEmpty()
                ? null
                : v -> {
                    UserInfo i = v.getInfo();
                    return PagingUtility.contains(i.getUsername(), needle)
                            || PagingUtility.contains(i.getEmail(), needle)
                            || PagingUtility.contains(i.getFirstName(), needle)
                            || PagingUtility.contains(i.getLastName(), needle)
                            || PagingUtility.contains(i.getPhone(), needle)
                            || PagingUtility.contains(i.getFirstSignupIp(), needle)
                            || PagingUtility.contains(i.getLastLoginIp(), needle)
                            || PagingUtility.contains(i.getNotes(), needle);
                };

        String effectiveSort = (sort == null || sort.isEmpty()) ? "lastLogin" : sort;
        String effectiveDir = (direction == null || direction.isEmpty()) ? "desc" : direction;

        return PagingUtility.apply(
                views,
                filter,
                USER_DETAILS_COMPARATORS,
                effectiveSort,
                effectiveDir,
                page,
                size,
                search);
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
