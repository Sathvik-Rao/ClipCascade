package com.acme.clipcascade.service;

import java.security.MessageDigest;
import java.util.List;
import java.util.function.Consumer;

import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.model.Users;
import com.acme.clipcascade.repo.UserRepo;
import com.acme.clipcascade.utils.HashingUtility;
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
