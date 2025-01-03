package com.acme.clipcascade.utils;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import org.springframework.security.crypto.password.PasswordEncoder;

public class HashingUtility {
    public static String convertBytesToLowercaseHex(byte[] hashBytes) {
        StringBuilder hexString = new StringBuilder();
        for (byte b : hashBytes) {
            hexString.append(String.format("%02x", b));
        }

        return hexString.toString();
    }

    public static String hashPassword(String input, PasswordEncoder encoder) {
        return encoder.encode(input);
    }

    public static String doubleHash(String input, MessageDigest sha, PasswordEncoder encoder) {
        String layer1 = convertBytesToLowercaseHex(
                sha.digest(input.getBytes(StandardCharsets.UTF_8))); // Layer 1 hash

        return hashPassword(layer1, encoder); // Layer 2 hash
    }
}
