package com.acme.ClipCascade.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Collections;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.controller.ClipCascadeController;
import com.acme.clipcascade.model.ClipboardData;
import com.acme.clipcascade.model.UserPrincipal;
import com.acme.clipcascade.model.Users;
import com.acme.clipcascade.service.BruteForceProtectionService;
import com.acme.clipcascade.service.CaptchaService;
import com.acme.clipcascade.service.DonationService;
import com.acme.clipcascade.service.FacadeUserService;
import com.acme.clipcascade.service.SessionService;
import com.acme.clipcascade.service.UserInfoService;
import com.acme.clipcascade.service.UserService;
import com.acme.clipcascade.service.WebSocketStatsService;

/**
 * The clipboard endpoint is an opaque relay.
 *
 * It rebuilds the outgoing message from three getters on ClipboardData, so any
 * other top-level field a client sends is dropped in transit. Clients therefore
 * nest their protocol envelope inside `payload`, and this test pins the two
 * properties that makes safe: `payload` is relayed byte-identical, and nothing
 * else about it is interpreted.
 *
 * Protocol v2 originally shipped four extra top-level fields and was silently
 * stripped here, which broke sync in the default configuration. No test crossed
 * the server, so nothing caught it.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ClipCascadeRelayTest {

    @Mock private ClipCascadeProperties clipCascadeProperties;
    @Mock private FacadeUserService facadeUserService;
    @Mock private UserService userService;
    @Mock private SimpMessagingTemplate simpMessagingTemplate;
    @Mock private CaptchaService captchaService;
    @Mock private UserInfoService userInfoService;
    @Mock private SessionService sessionService;
    @Mock private BruteForceProtectionService bruteForceProtectionService;
    @Mock private WebSocketStatsService webSocketStatsService;
    @Mock private DonationService donationService;

    private ClipCascadeController controller() {
        return new ClipCascadeController(
                clipCascadeProperties,
                facadeUserService,
                userService,
                simpMessagingTemplate,
                captchaService,
                userInfoService,
                sessionService,
                bruteForceProtectionService,
                webSocketStatsService,
                donationService);
    }

    private UsernamePasswordAuthenticationToken principal() {
        Users user = new Users();
        user.setUsername("alice");
        user.setPassword("irrelevant");
        user.setRole("ROLE_USER");
        UserPrincipal userPrincipal = new UserPrincipal(user, bruteForceProtectionService);
        return new UsernamePasswordAuthenticationToken(
                userPrincipal, null, Collections.emptyList());
    }

    private ClipboardData relay(ClipboardData in) {
        when(clipCascadeProperties.isP2pEnabled()).thenReturn(false);
        controller().sendPrivateMessage(principal(), in);

        ArgumentCaptor<ClipboardData> sent = ArgumentCaptor.forClass(ClipboardData.class);
        verify(simpMessagingTemplate)
                .convertAndSendToUser(eq("alice"), eq("/queue/cliptext"), sent.capture());
        return sent.getValue();
    }

    @Test
    void payloadIsRelayedByteIdentical() {
        // Clients nest their protocol envelope in here. If anyone ever adds
        // trimming, re-encoding, sanitising or truncation to the relay, this
        // breaks loudly instead of silently corrupting every message.
        String envelope =
                "{\"v\":2,\"type\":\"text\",\"senderDeviceId\":\"device-A\",\"counter\":1,"
                        + "\"ts\":1700000000000,\"payload\":\"{\\\"nonce\\\":\\\"abc\\\"}\"}";

        ClipboardData out = relay(new ClipboardData(envelope, "text", null));

        assertEquals(envelope, out.getPayload());
    }

    @Test
    void typeDefaultsToTextWhenAbsent() {
        assertEquals("text", relay(new ClipboardData("x", null, null)).getType());
    }

    @Test
    void typeIsOtherwisePassedThrough() {
        assertEquals("image", relay(new ClipboardData("x", "image", null)).getType());
    }

    @Test
    void metadataIsRelayedUntouched() {
        java.util.Map<String, Object> metadata = java.util.Map.of("id", "abc", "index", 0);
        assertSame(metadata, relay(new ClipboardData("x", "text", metadata)).getMetadata());
    }

    @Test
    void nothingIsRelayedWhenP2pIsEnabled() {
        when(clipCascadeProperties.isP2pEnabled()).thenReturn(true);
        controller().sendPrivateMessage(principal(), new ClipboardData("x", "text", null));
        verify(simpMessagingTemplate, never())
                .convertAndSendToUser(anyString(), anyString(), any(Object.class));
    }
}
