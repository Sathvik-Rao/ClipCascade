package com.acme.clipcascade.service;

import java.security.MessageDigest;
import java.util.List;
import java.util.function.Consumer;

import org.springframework.security.core.session.SessionInformation;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.model.Users;
import com.acme.clipcascade.repo.UserRepo;
import com.acme.clipcascade.utils.HashingUtility;
import com.acme.clipcascade.utils.UserValidator;

import jakarta.persistence.EntityNotFoundException;

@Service
public class UserService {

    private final UserRepo userRepo;
    private final BCryptPasswordEncoder bCryptPasswordEncoder;
    private final MessageDigest shaPasswordEncoder;
    private final SessionRegistry sessionRegistry;

    public UserService(UserRepo userRepo,
            BCryptPasswordEncoder bCryptPasswordEncoder,
            MessageDigest shaPasswordEncoder,
            SessionRegistry sessionRegistry) {

        this.userRepo = userRepo;
        this.bCryptPasswordEncoder = bCryptPasswordEncoder;
        this.shaPasswordEncoder = shaPasswordEncoder;
        this.sessionRegistry = sessionRegistry;
    }

    public void insertDefaultUserIfEmpty() {
        // insert default user if empty
        if (userRepo.count() == 0) {
            userRepo.save(new Users("admin",
                    HashingUtility.doubleHash("admin123", shaPasswordEncoder,
                            bCryptPasswordEncoder),
                    RoleConstants.ADMIN,
                    true));
        }
    }

    public Users registerUser(Users user) {
        // validate user
        if (!UserValidator.isValid(user)
                || userRepo.findByUsernameIgnoreCase(user.getUsername()) != null) {
            return null;
        }

        // hash password
        user.setPassword(bCryptPasswordEncoder.encode(user.getPassword()));
        return userRepo.save(user); // save user
    }

    public List<Users> getAllUsers() {
        List<Users> users = userRepo.findByRole(RoleConstants.USER);
        users.forEach(user -> {
            user.setPassword(null);
        }); // Set password to null
        return users;
    }

    public boolean deleteUser(String username) {
        if (!UserValidator.isValidUsername(username)) {
            return false;
        }

        return userRepo.findById(username).map(user -> {
            userRepo.deleteById(username);
            return true;
        }).orElse(false);
    }

    public Users updateUsername(
            String oldUsername,
            String newUsername,
            String principalUsername) {

        if (!UserValidator.isValidUsername(oldUsername)
                || !UserValidator.isValidUsername(newUsername)
                || userRepo.findByUsernameIgnoreCase(newUsername) != null) {
            return null;
        }

        Users oldUser = userRepo.findById(oldUsername).get();
        Users newUser = new Users(
                newUsername,
                oldUser.getPassword(),
                oldUser.getRole(),
                oldUser.getEnabled()); // clone user with new username

        if (principalUsername.equals(oldUsername)) {
            // If the admin is changing their own username, logout the admin sessions
            // before deleting the user to avoid session inconsistencies
            logoutSessions(oldUsername);
        }

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

    public String logoutSessions(String username) {
        if (!UserValidator.isValidUsername(username)) {
            throw new IllegalArgumentException("Invalid username");
        }

        // Check if user exists
        userRepo.findById(username).orElseThrow(() -> new EntityNotFoundException("User not found"));

        // Iterate over all principals in the SessionRegistry
        List<Object> principals = sessionRegistry.getAllPrincipals();
        boolean foundUser = false;

        for (Object principal : principals) {
            if (principal instanceof UserDetails userDetails) {
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

    private Users updateUserField(String username, Consumer<Users> updater) {
        return userRepo.findById(username)
                .map(user -> {
                    updater.accept(user);
                    return userRepo.save(user);
                })
                .orElse(null);
    }

}
