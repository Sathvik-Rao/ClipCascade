package com.acme.clipcascade.service;

import java.security.MessageDigest;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Predicate;

import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.model.PageResponse;
import com.acme.clipcascade.model.Users;
import com.acme.clipcascade.repo.UserRepo;
import com.acme.clipcascade.utils.HashingUtility;
import com.acme.clipcascade.utils.PagingUtility;
import com.acme.clipcascade.utils.UserValidator;

@Service
public class UserService {

    private final UserRepo userRepo;
    private final BCryptPasswordEncoder bCryptPasswordEncoder;
    private final MessageDigest shaPasswordEncoder;

    public UserService(UserRepo userRepo,
            BCryptPasswordEncoder bCryptPasswordEncoder,
            MessageDigest shaPasswordEncoder) {

        this.userRepo = userRepo;
        this.bCryptPasswordEncoder = bCryptPasswordEncoder;
        this.shaPasswordEncoder = shaPasswordEncoder;
    }

    public void doubleHashAndCreateUser(
            String username,
            String password,
            String role,
            boolean enabled) {

        userRepo.save(new Users(
                username,
                HashingUtility.doubleHash(password, shaPasswordEncoder,
                        bCryptPasswordEncoder),
                role,
                enabled));
    }

    public boolean isTableEmpty() {
        return userRepo.count() == 0;
    }

    public Users registerUser(Users user) {
        user.setPassword(bCryptPasswordEncoder.encode(user.getPassword())); // hash password
        return userRepo.save(user); // save user
    }

    public boolean userExists(String username) {
        return userRepo.findByUsernameIgnoreCase(username) != null;
    }

    public List<Users> getUsers(String role) {
        List<Users> users = userRepo.findByRoleOrderByUsernameAsc(role);
        users.forEach(user -> {
            user.setPassword(null);
        }); // Set password to null
        return users;
    }

    private static final Map<String, Comparator<Users>> USERS_COMPARATORS = Map.of(
            "username", Comparator.comparing(Users::getUsername,
                    Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)),
            "enabled", Comparator.comparing(Users::getEnabled,
                    Comparator.nullsLast(Boolean::compare)));

    /**
     * Server-side paged/sorted/searched view of users with the given role.
     * Used by the admin panel; the legacy getUsers(role) endpoint is preserved.
     */
    public PageResponse<Users> getUsersPage(
            String role,
            int page,
            int size,
            String sort,
            String direction,
            String search) {

        List<Users> users = userRepo.findByRole(role);
        users.forEach(user -> user.setPassword(null));

        String needle = (search == null) ? "" : search.trim().toLowerCase();
        Predicate<Users> filter = needle.isEmpty()
                ? null
                : u -> PagingUtility.contains(u.getUsername(), needle);

        String effectiveSort = (sort == null || sort.isEmpty()) ? "username" : sort;
        String effectiveDir = (direction == null || direction.isEmpty()) ? "asc" : direction;

        return PagingUtility.apply(
                users,
                filter,
                USERS_COMPARATORS,
                effectiveSort,
                effectiveDir,
                page,
                size,
                search);
    }

    public long countUsers() {
        return userRepo.countByRole(RoleConstants.USER);
    }

    public List<Users> getAllUsers() {
        List<Users> users = userRepo.findAll();
        users.forEach(user -> {
            user.setPassword(null);
        }); // Set password to null
        return users;
    }

    public Users verifyAdminExistence() {
        List<Users> users = userRepo.findByRole(RoleConstants.ADMIN);

        if (users.isEmpty()) {
            throw new IllegalStateException("No admin user exists!");
        }

        if (users.size() > 1) {
            throw new IllegalStateException("More than one admin user exists!");
        }

        return users.get(0);
    }

    public boolean deleteUser(String username) {
        return userRepo.findById(username).map(user -> {
            userRepo.deleteById(username);
            return true;
        }).orElse(false);
    }

    public Users updateUsername(
            String oldUsername,
            String newUsername) {

        Users oldUser = userRepo.findById(oldUsername).get();
        Users newUser = new Users(
                newUsername,
                oldUser.getPassword(),
                oldUser.getRole(),
                oldUser.getEnabled()); // clone user with new username

        userRepo.deleteById(oldUsername); // first delete the old user

        return userRepo.save(newUser); // then save the new user
    }

    public Users updatePassword(String username, String newPassword) {
        if (!UserValidator.isValidUsername(username)
                || !UserValidator.isValidPassword(newPassword)) {

            return null;
        }

        return updateUserField(username, user -> user.setPassword(bCryptPasswordEncoder.encode(newPassword)));
    }

    public Users updateUserRole(String username, String role) {
        if (!UserValidator.isValidUsername(username)
                || !UserValidator.isValidRole(role)) {

            return null;
        }

        return updateUserField(username, user -> user.setRole(role));
    }

    public Users updateUserStatus(String username, boolean enable) {
        if (!UserValidator.isValidUsername(username)) {
            return null;
        }

        return updateUserField(username, user -> user.setEnabled(enable));
    }

    public boolean isNonAdminUser(String username) {
        if (!UserValidator.isValidUsername(username)) {
            return true;
        }

        Users user = userRepo.findById(username).orElse(null);
        return user == null || !RoleConstants.ADMIN.equals(user.getRole());
    }

    private Users updateUserField(String username, Consumer<Users> updater) {
        return userRepo.findById(username)
                .map(user -> {
                    updater.accept(user);
                    return userRepo.save(user);
                })
                .orElse(null);
    }

}
