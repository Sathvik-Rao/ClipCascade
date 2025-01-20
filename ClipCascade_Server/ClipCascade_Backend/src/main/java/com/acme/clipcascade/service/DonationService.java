package com.acme.clipcascade.service;

import java.util.Map;

import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import com.acme.clipcascade.config.ClipCascadeProperties;
import com.acme.clipcascade.constants.ServerConstants;
import com.fasterxml.jackson.databind.ObjectMapper;

import ch.qos.logback.classic.Logger;

@Service
public class DonationService {
    private final ClipCascadeProperties clipCascadeProperties;
    private final ObjectMapper objectMapper;
    private final Logger logger;
    private String donationUrl;

    public DonationService(
            ClipCascadeProperties clipCascadeProperties,
            ObjectMapper objectMapper) {

        this.clipCascadeProperties = clipCascadeProperties;
        this.objectMapper = objectMapper;
        this.logger = (Logger) LoggerFactory.getLogger(DonationService.class);
    }

    public void initializeDonationUrl() {
        if (!clipCascadeProperties.isDonationsEnabled())
            return;

        try {
            String response = new RestTemplate()
                    .getForObject(ServerConstants.METADATA_URL, String.class);

            donationUrl = (String) objectMapper.readValue(response, Map.class).get("funding");
        } catch (Exception e) {
            donationUrl = null;
            logger.error("Failed to fetch donation URL: {}", e.getMessage());
        }
    }

    public String getDonationUrl() {
        return donationUrl;
    }
}
