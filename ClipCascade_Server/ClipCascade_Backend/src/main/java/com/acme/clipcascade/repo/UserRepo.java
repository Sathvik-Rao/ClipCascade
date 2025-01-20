package com.acme.clipcascade.repo;

import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;

import com.acme.clipcascade.model.Users;

public interface UserRepo extends JpaRepository<Users, String> {

    Users findByUsernameIgnoreCase(String username);

    List<Users> findByRole(String role);

    long countByRole(String role);
}
