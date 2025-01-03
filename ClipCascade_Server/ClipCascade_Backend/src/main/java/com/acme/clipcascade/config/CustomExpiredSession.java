package com.acme.clipcascade.config;

import java.io.IOException;

import org.springframework.security.web.session.SessionInformationExpiredEvent;
import org.springframework.security.web.session.SessionInformationExpiredStrategy;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletResponse;

public class CustomExpiredSession implements SessionInformationExpiredStrategy {

    @Override
    public void onExpiredSessionDetected(SessionInformationExpiredEvent event)
            throws IOException, ServletException {

        HttpServletResponse response = event.getResponse();

        // Redirect to login page with an "expired" parameter
        response.sendRedirect("/login?expired");
    }
}
