package com.acme.clipcascade.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.validation.constraints.NotNull;

@Entity
@Table(name = "user_info")
public class UserInfo {

    @Id
    @NotNull(message = "Username is required")
    private String username;

    @Column(columnDefinition = "boolean default false")
    private boolean markedForDeletion;
    private Long firstSignup;
    private Long lastLogin;
    private String firstSignupIp;
    private String lastLoginIp;

    @Column(columnDefinition = "int default 0")
    private int failedLoginAttempts;

    private String lockoutTime;
    private Long passwordChangedAt;
    private String email;
    private String otp;
    private String phone;
    private String firstName;
    private String lastName;
    private String notes;

    public UserInfo() {
    }

    public UserInfo(String username, boolean markedForDeletion, Long firstSignup, Long lastLogin,
            String firstSignupIp, String lastLoginIp, int failedLoginAttempts, String lockoutTime,
            Long passwordChangedAt, String email, String otp, String phone, String firstName, String lastName,
            String notes) {
        this.username = username;
        this.markedForDeletion = markedForDeletion;
        this.firstSignup = firstSignup;
        this.lastLogin = lastLogin;
        this.firstSignupIp = firstSignupIp;
        this.lastLoginIp = lastLoginIp;
        this.failedLoginAttempts = failedLoginAttempts;
        this.lockoutTime = lockoutTime;
        this.passwordChangedAt = passwordChangedAt;
        this.email = email;
        this.otp = otp;
        this.phone = phone;
        this.firstName = firstName;
        this.lastName = lastName;
        this.notes = notes;
    }

    public UserInfo(UserInfo userInfo) {
        this.username = userInfo.getUsername();
        this.markedForDeletion = userInfo.isMarkedForDeletion();
        this.firstSignup = userInfo.getFirstSignup();
        this.lastLogin = userInfo.getLastLogin();
        this.firstSignupIp = userInfo.getFirstSignupIp();
        this.lastLoginIp = userInfo.getLastLoginIp();
        this.failedLoginAttempts = userInfo.getFailedLoginAttempts();
        this.lockoutTime = userInfo.getLockoutTime();
        this.passwordChangedAt = userInfo.getPasswordChangedAt();
        this.email = userInfo.getEmail();
        this.otp = userInfo.getOtp();
        this.phone = userInfo.getPhone();
        this.firstName = userInfo.getFirstName();
        this.lastName = userInfo.getLastName();
        this.notes = userInfo.getNotes();
    }

    public String getUsername() {
        return this.username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public boolean isMarkedForDeletion() {
        return this.markedForDeletion;
    }

    public boolean getMarkedForDeletion() {
        return this.markedForDeletion;
    }

    public void setMarkedForDeletion(boolean markedForDeletion) {
        this.markedForDeletion = markedForDeletion;
    }

    public Long getFirstSignup() {
        return this.firstSignup;
    }

    public void setFirstSignup(Long firstSignup) {
        this.firstSignup = firstSignup;
    }

    public Long getLastLogin() {
        return this.lastLogin;
    }

    public void setLastLogin(Long lastLogin) {
        this.lastLogin = lastLogin;
    }

    public String getFirstSignupIp() {
        return this.firstSignupIp;
    }

    public void setFirstSignupIp(String firstSignupIp) {
        this.firstSignupIp = firstSignupIp;
    }

    public String getLastLoginIp() {
        return this.lastLoginIp;
    }

    public void setLastLoginIp(String lastLoginIp) {
        this.lastLoginIp = lastLoginIp;
    }

    public int getFailedLoginAttempts() {
        return this.failedLoginAttempts;
    }

    public void setFailedLoginAttempts(int failedLoginAttempts) {
        this.failedLoginAttempts = failedLoginAttempts;
    }

    public String getLockoutTime() {
        return this.lockoutTime;
    }

    public void setLockoutTime(String lockoutTime) {
        this.lockoutTime = lockoutTime;
    }

    public Long getPasswordChangedAt() {
        return this.passwordChangedAt;
    }

    public void setPasswordChangedAt(Long passwordChangedAt) {
        this.passwordChangedAt = passwordChangedAt;
    }

    public String getEmail() {
        return this.email;
    }

    public void setEmail(String email) {
        this.email = email;
    }

    public String getOtp() {
        return this.otp;
    }

    public void setOtp(String otp) {
        this.otp = otp;
    }

    public String getPhone() {
        return this.phone;
    }

    public void setPhone(String phone) {
        this.phone = phone;
    }

    public String getFirstName() {
        return this.firstName;
    }

    public void setFirstName(String firstName) {
        this.firstName = firstName;
    }

    public String getLastName() {
        return this.lastName;
    }

    public void setLastName(String lastName) {
        this.lastName = lastName;
    }

    public String getNotes() {
        return this.notes;
    }

    public void setNotes(String notes) {
        this.notes = notes;
    }

    @Override
    public String toString() {
        return "{" +
                " username='" + getUsername() + "'" +
                ", markedForDeletion='" + isMarkedForDeletion() + "'" +
                ", firstSignup='" + getFirstSignup() + "'" +
                ", lastLogin='" + getLastLogin() + "'" +
                ", firstSignupIp='" + getFirstSignupIp() + "'" +
                ", lastLoginIp='" + getLastLoginIp() + "'" +
                ", failedLoginAttempts='" + getFailedLoginAttempts() + "'" +
                ", lockoutTime='" + getLockoutTime() + "'" +
                ", passwordChangedAt='" + getPasswordChangedAt() + "'" +
                ", email='" + getEmail() + "'" +
                ", otp='" + getOtp() + "'" +
                ", phone='" + getPhone() + "'" +
                ", firstName='" + getFirstName() + "'" +
                ", lastName='" + getLastName() + "'" +
                ", notes='" + getNotes() + "'" +
                "}";
    }

}
