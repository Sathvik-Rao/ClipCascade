package com.acme.clipcascade.utils;

import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.model.Users;

public class UserValidator {
    private static final int MIN_RAW_PASSWORD_LENGTH = 12;
    private static final int SHA3_512_HEX_LENGTH = 128;
    private static final String SHA3_512_HEX_PATTERN = "^[0-9a-fA-F]{128}$";

    public static boolean isValid(Users user) {
        return user != null
                && user.getUsername() != null && !user.getUsername().isBlank()
                && !user.getUsername().startsWith(" ") && !user.getUsername().endsWith(" ")
                && user.getPassword() != null && !user.getPassword().isEmpty()
                && user.getRole() != null && (user.getRole().equals(RoleConstants.ADMIN)
                        || user.getRole().equals(RoleConstants.USER));
    }

    public static boolean isValidUsername(String username) {
        return username != null && !username.isBlank()
                && !username.startsWith(" ") && !username.endsWith(" ");
    }

    public static boolean isValidPassword(String password) {
        if (password == null || password.isBlank()) {
            return false;
        }

        return password.length() >= MIN_RAW_PASSWORD_LENGTH
                || (password.length() == SHA3_512_HEX_LENGTH && password.matches(SHA3_512_HEX_PATTERN));
    }

    public static boolean isValidRole(String role) {
        return role != null && (role.equals(RoleConstants.ADMIN) || role.equals(RoleConstants.USER));
    }
}
