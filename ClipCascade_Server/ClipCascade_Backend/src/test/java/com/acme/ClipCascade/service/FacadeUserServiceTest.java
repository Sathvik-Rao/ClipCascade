package com.acme.ClipCascade.service;

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.config.P2PWebSocketHandler;
import com.acme.clipcascade.constants.RoleConstants;
import com.acme.clipcascade.service.FacadeUserService;
import com.acme.clipcascade.service.SessionService;
import com.acme.clipcascade.service.UserInfoService;
import com.acme.clipcascade.service.UserService;

@ExtendWith(MockitoExtension.class)
class FacadeUserServiceTest {

    @Mock
    private UserService userService;

    @Mock
    private UserInfoService userInfoService;

    @Mock
    private ClipCascadeProperties clipCascadeProperties;

    @Mock
    private P2PWebSocketHandler p2pWebSocketHandler;

    @Mock
    private SessionService sessionService;

    @InjectMocks
    private FacadeUserService facadeUserService;

    @Test
    void emptyDatabaseRequiresInitialAdminPassword() {
        when(userService.isTableEmpty()).thenReturn(true);
        when(clipCascadeProperties.isInitialAdminPasswordConfigured()).thenReturn(false);

        assertThrows(IllegalStateException.class, facadeUserService::insertDefaultAdminUserIfEmpty);

        verify(userService, never()).doubleHashAndCreateUser(
                "admin",
                "admin123",
                RoleConstants.ADMIN,
                true);
    }

    @Test
    void emptyDatabaseCreatesConfiguredInitialAdmin() {
        when(userService.isTableEmpty()).thenReturn(true);
        when(clipCascadeProperties.isInitialAdminPasswordConfigured()).thenReturn(true);
        when(clipCascadeProperties.getInitialAdminUsername()).thenReturn("owner");
        when(clipCascadeProperties.getInitialAdminPassword()).thenReturn("strong-password");

        facadeUserService.insertDefaultAdminUserIfEmpty();

        verify(userService).doubleHashAndCreateUser(
                "owner",
                "strong-password",
                RoleConstants.ADMIN,
                true);
        verify(userInfoService).registerNewUser("owner");
    }

    @Test
    void updateOwnPasswordRejectsWrongCurrentPassword() {
        when(userService.passwordMatches("alice", "wrong-current")).thenReturn(false);

        assertNull(
                facadeUserService.updateOwnPassword(
                        "alice",
                        "wrong-current",
                        "new-password-long-enough",
                        sessionService));

        verify(userService, never()).updatePassword(anyString(), anyString());
        verify(userInfoService, never()).setPasswordChangeTime(anyString(), anyLong());
    }
}
