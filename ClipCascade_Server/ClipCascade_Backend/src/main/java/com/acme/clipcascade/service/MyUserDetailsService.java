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

    MyUserDetailsService(UserRepo userRepo) {
        this.userRepo = userRepo;
    }

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        return userRepo.findById(username)
                .map(UserPrincipal::new) // Maps Users to UserPrincipal directly
                .orElseThrow(() -> new UsernameNotFoundException("User not found: " + username));
    }

}
