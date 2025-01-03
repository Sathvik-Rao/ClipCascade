package com.acme.clipcascade.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.validation.constraints.NotNull;

/**
 * User entity
 * 
 * Renamed to Users to prevent conflicts with the User class in Spring Security.
 */
@Entity
@Table(name = "users")
public class Users {

    @Id
    @NotNull(message = "Username is required") // Validation constraint at application level
    private String username;

    @NotNull(message = "Password is required")
    @Column(nullable = false) // Database constraint at schema level
    private String password;

    @NotNull(message = "Role is required")
    @Column(nullable = false, columnDefinition = "varchar(255) default 'USER'")
    private String role;

    @NotNull(message = "Enabled status is required")
    @Column(nullable = false, columnDefinition = "boolean default true")
    private boolean enabled;

    public Users() {
        this.enabled = true;
    }

    public Users(String username, String password, String role) {
        this(username, password, role, true);
    }

    public Users(String username, String password, String role, boolean enabled) {
        this.username = username;
        this.password = password;
        this.role = role;
        this.enabled = enabled;
    }

    public String getUsername() {
        return this.username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getPassword() {
        return this.password;
    }

    public void setPassword(String password) {
        this.password = password;
    }

    public String getRole() {
        return this.role;
    }

    public void setRole(String role) {
        this.role = role;
    }

    public boolean getEnabled() {
        return this.enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    @Override
    public String toString() {
        return "{" +
                " username='" + getUsername() + "'" +
                ", role='" + getRole() + "'" +
                ", enabled='" + getEnabled() + "'" +
                "}";
    }

}
