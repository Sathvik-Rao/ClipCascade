package com.acme.clipcascade.service;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;

import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.model.UserInfo;
import com.acme.clipcascade.repo.UserInfoRepo;
import com.acme.clipcascade.utils.IpAddressResolver;
import com.acme.clipcascade.utils.TimeUtility;

@Service
public class UserInfoService {

    private final UserInfoRepo userInfoRepo;

    public UserInfoService(UserInfoRepo userInfoRepo) {
        this.userInfoRepo = userInfoRepo;
    }

    public boolean userExists(String username) {
        return userInfoRepo.findByUsernameIgnoreCase(username) != null;
    }

    public UserInfo setPasswordChangeTime(String username, long passwordChangedAt) {
        return updateUserField(username, user -> user.setPasswordChangedAt(passwordChangedAt));
    }

    public void purgeDeletedUsers() {
        userInfoRepo.deleteAllMarkedForDeletion();
    }

    public UserInfo markUserForDeletion(String username) {
        return userInfoRepo.findById(username)
                .map(userDetails -> {
                    UserInfo oldCopy = new UserInfo(userDetails);
                    userDetails.setMarkedForDeletion(true);
                    userInfoRepo.save(userDetails);
                    return oldCopy;
                })
                .orElse(null);
    }

    public UserInfo getUserDetails(String username) {
        return userInfoRepo.findById(username).orElse(null);
    }

    public Set<String> getInactiveUsers(long timeout) {
        List<UserInfo> userInfos = getAllUserDetails();
        Set<String> inactiveUsers = new HashSet<>();

        for (UserInfo userInfo : userInfos) {
            if (!userInfo.getMarkedForDeletion()) {
                if (userInfo.getLastLogin() == null || userInfo.getLastLogin() == 0) {
                    if (userInfo.getFirstSignup() + timeout < TimeUtility.getCurrentTimeInSeconds()) {

                        inactiveUsers.add(userInfo.getUsername());
                    }
                } else {
                    if (userInfo.getLastLogin() + timeout < TimeUtility.getCurrentTimeInSeconds()) {

                        inactiveUsers.add(userInfo.getUsername());
                    }
                }
            }
        }

        return inactiveUsers;
    }

    public List<UserInfo> getAllUserDetails() {
        return userInfoRepo.findAll(Sort.by(Sort.Direction.DESC, "lastLogin"));
    }

    public UserInfo setLoginDetails(
            String username,
            String lastLoginIp,
            long lastLogin,
            int failedLoginAttempts,
            String lockoutTime) {

        return updateUserField(username, user -> {
            user.setLastLoginIp(lastLoginIp);
            user.setLastLogin(lastLogin);
            user.setFailedLoginAttempts(failedLoginAttempts);
            user.setLockoutTime(lockoutTime);
        });
    }

    public UserInfo registerNewUser(UserInfo userInfo) {
        return userInfoRepo.save(userInfo);
    }

    public UserInfo registerNewUser(String username) {
        return userInfoRepo.save(new UserInfo(
                username,
                false,
                TimeUtility.getCurrentTimeInSeconds(),
                null,
                IpAddressResolver.getUserIpAddress(),
                null,
                0,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null));
    }

    private UserInfo updateUserField(String username, Consumer<UserInfo> updater) {
        return userInfoRepo.findById(username)
                .map(user -> {
                    updater.accept(user);
                    return userInfoRepo.save(user);
                })
                .orElse(null);
    }

}
