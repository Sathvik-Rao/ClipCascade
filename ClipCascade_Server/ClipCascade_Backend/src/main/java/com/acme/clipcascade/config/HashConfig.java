package com.acme.clipcascade.config;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

@Configuration
public class HashConfig {
    @Bean
    public MessageDigest shaPasswordEncoder() throws NoSuchAlgorithmException {
        // Layer 1 hash
        return MessageDigest.getInstance("SHA3-512");
    }

    @Bean
    public BCryptPasswordEncoder passwordEncoder() {
        // Layer 2 hash
        return new BCryptPasswordEncoder(
                BCryptPasswordEncoder.BCryptVersion.$2B, // BCrypt version 2b
                12) // 2^12 rounds
        {
            /**
             * BCrypt only processes up to 72 bytes of input. Any extra
             * characters would be silently ignored by the underlying native
             * library, which could lead to inconsistencies between encode()
             * and matches() or break backward compatibility with older hashes.
             * To mirror that behavior explicitly, we truncate to 72 chars here.
             */
            private String truncate72(CharSequence raw) {
                String s = raw.toString();
                return (s.length() > 72)
                        ? s.substring(0, 72)
                        : s;
            }

            @Override
            public String encode(CharSequence rawPassword) {
                return super.encode(truncate72(rawPassword));
            }

            @Override
            public boolean matches(CharSequence rawPassword, String encodedPassword) {
                return super.matches(truncate72(rawPassword), encodedPassword);
            }
        };
    }
}
