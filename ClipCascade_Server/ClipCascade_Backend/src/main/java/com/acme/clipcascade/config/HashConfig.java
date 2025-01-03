package com.acme.clipcascade.config;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

@Configuration
public class HashConfig {
    @Bean
    public BCryptPasswordEncoder bCryptPasswordEncoder() {
        // Layer 2 hash
        return new BCryptPasswordEncoder(
                BCryptPasswordEncoder.BCryptVersion.$2B, // BCrypt version 2b
                12); // 2^12 rounds
    }

    @Bean
    public MessageDigest shaPasswordEncoder() throws NoSuchAlgorithmException {
        // Layer 1 hash
        return MessageDigest.getInstance("SHA3-512");
    }
}
