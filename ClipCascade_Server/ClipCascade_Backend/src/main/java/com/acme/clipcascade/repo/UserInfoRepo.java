package com.acme.clipcascade.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

import com.acme.clipcascade.model.UserInfo;

import jakarta.transaction.Transactional;

public interface UserInfoRepo extends JpaRepository<UserInfo, String> {

    UserInfo findByUsernameIgnoreCase(String username);

    @Modifying
    @Transactional
    @Query("DELETE FROM UserInfo u WHERE u.markedForDeletion = true")
    void deleteAllMarkedForDeletion();

}
