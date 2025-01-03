package com.acme.clipcascade.utils;

import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.model.Users;

public class UserValidator {
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
        return password != null && !password.isEmpty();
    }

    public static boolean isValidRole(String role) {
        return role != null && (role.equals(RoleConstants.ADMIN) || role.equals(RoleConstants.USER));
    }
}
