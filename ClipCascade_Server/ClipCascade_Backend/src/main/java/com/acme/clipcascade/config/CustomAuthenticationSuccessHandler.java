package com.acme.clipcascade.config;

import java.io.IOException;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.security.core.Authentication;
import org.springframework.security.web.authentication.AuthenticationSuccessHandler;

import com.acme.clipcascade.model.IpAttemptDetails;
import com.acme.clipcascade.service.BruteForceProtectionService;
import com.acme.clipcascade.service.FacadeUserService;

public class CustomAuthenticationSuccessHandler implements AuthenticationSuccessHandler {

    private final BruteForceProtectionService bruteForceProtectionService;
    private final FacadeUserService facadeUserService;

    public CustomAuthenticationSuccessHandler(
            BruteForceProtectionService bruteForceProtectionService,
            FacadeUserService facadeUserService) {

        this.bruteForceProtectionService = bruteForceProtectionService;
        this.facadeUserService = facadeUserService;
    }

    @Override
    public void onAuthenticationSuccess(
            HttpServletRequest request,
            HttpServletResponse response,
            Authentication authentication) throws IOException {

        // Remove current user ip from the brute force tracker
        IpAttemptDetails ipDetails = bruteForceProtectionService.removeIpDetails(authentication.getName());

        // save ip details to the database
        facadeUserService.setLoginDetails(authentication.getName(), ipDetails);

        // Redirect to the home page
        response.sendRedirect("/");
    }
}
