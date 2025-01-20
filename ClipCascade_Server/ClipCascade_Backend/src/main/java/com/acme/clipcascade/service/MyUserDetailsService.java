package com.acme.clipcascade.service;

import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.model.UserPrincipal;
import com.acme.clipcascade.repo.UserRepo;

@Service
public class MyUserDetailsService implements UserDetailsService {

    private final UserRepo userRepo;
    private final BruteForceProtectionService bruteForceProtectionService;

    MyUserDetailsService(
            UserRepo userRepo,
            BruteForceProtectionService bruteForceProtectionService) {

        this.userRepo = userRepo;
        this.bruteForceProtectionService = bruteForceProtectionService;
    }

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        return userRepo.findById(username)
                .map(user -> new UserPrincipal(
                        user,
                        bruteForceProtectionService))
                .orElseThrow(() -> new UsernameNotFoundException("User not found: " + username));
    }

}
