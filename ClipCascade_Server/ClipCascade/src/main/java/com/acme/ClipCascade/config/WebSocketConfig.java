package com.acme.ClipCascade.config;

import org.springframework.lang.NonNull;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {
    @Value("${CC_MAX_MESSAGE_SIZE}")
    private int MAX_MESSAGE_SIZE_IN_MiB;

    @Override
    public void configureMessageBroker(@NonNull MessageBrokerRegistry config) {
        config.setApplicationDestinationPrefixes("/app");
        config.enableSimpleBroker("/topic").setHeartbeatValue(new long[] { 20000, 0 })
                .setTaskScheduler(heartbeatTaskScheduler());
    }

    @Override
    public void registerStompEndpoints(@NonNull StompEndpointRegistry registry) {
        registry.addEndpoint("/clipsocket").setAllowedOrigins("*");
    }

    @Bean
    public TaskScheduler heartbeatTaskScheduler() {
        ThreadPoolTaskScheduler taskScheduler = new ThreadPoolTaskScheduler();
        taskScheduler.setPoolSize(1);
        taskScheduler.setThreadNamePrefix("WebSocketHeartbeat-");
        return taskScheduler;
    }

    // WebSocket settings
    @Bean
    public ServletServerContainerFactoryBean servletServerContainerFactoryBean() {
        /*
         * Adding additional bytes to accept client overhead on encryption and base64
         * encoding:
         * example:
         * 1. Original Size: 29,000,000 bytes
         * 2. Encryption Overhead: 28 bytes (12 bytes for nonce/IV + 16 bytes for
         * authentication tag)
         * 3. Calculate the Base64 size = (ceil(29,000,000+12+16) / 3) * 4
         * So, the total size after AES-GCM encryption and Base64 encoding for a 29 MB
         * file is approximately 38.67 MB.
         */
        int MAX_MESSAGE_SIZE = ((((MAX_MESSAGE_SIZE_IN_MiB << 20) + 30) / 3) * 4) + 1000000; // bytes

        ServletServerContainerFactoryBean factory = new ServletServerContainerFactoryBean();
        factory.setMaxTextMessageBufferSize(MAX_MESSAGE_SIZE);
        factory.setMaxBinaryMessageBufferSize(MAX_MESSAGE_SIZE);
        return factory;
    }

    // STOMP settings
    @Override
    public void configureWebSocketTransport(@SuppressWarnings("null") WebSocketTransportRegistration registration) {
        int MAX_MESSAGE_SIZE = ((((MAX_MESSAGE_SIZE_IN_MiB << 20) + 30) / 3) * 4) + 1000000; // bytes

        registration.setMessageSizeLimit(MAX_MESSAGE_SIZE); // default : 64 * 1024
        registration.setSendTimeLimit(20 * 10000); // default : 10 * 10000
        registration.setSendBufferSizeLimit(MAX_MESSAGE_SIZE); // default : 512 * 1024
    }
}
