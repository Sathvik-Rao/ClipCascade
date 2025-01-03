package com.acme.clipcascade.config;

import org.springframework.lang.NonNull;
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

    private final ClipCascadeProperties clipCascadeProperties;

    public WebSocketConfig(ClipCascadeProperties clipCascadeProperties) {
        this.clipCascadeProperties = clipCascadeProperties;
    }

    @Override
    public void configureMessageBroker(@NonNull MessageBrokerRegistry config) {
        // Prefix for client-to-server communication (application-level messages).
        // Clients send messages to server endpoints starting with "/app".
        config.setApplicationDestinationPrefixes("/app");

        // Prefix for user-specific destinations.
        // Used when sending messages to specific users via "/user/{username}/...".
        config.setUserDestinationPrefix("/user");

        /**
         * Enables a simple in-memory message broker to handle subscription-based
         * messaging.
         * - Subscriptions (sending messages to users) are created with prefixes like:
         * "/user/{username}/queue/.." for user-specific destinations.
         */
        config.enableSimpleBroker("/queue")
                .setHeartbeatValue(new long[] { 20000, 0 }) // Heartbeat intervals in milliseconds { send, receive }
                .setTaskScheduler(heartbeatTaskScheduler()); // Scheduler for heartbeats
    }

    @Override
    public void registerStompEndpoints(@NonNull StompEndpointRegistry registry) {
        // Clients will connect to this endpoint for WebSocket communication.
        registry.addEndpoint("/clipsocket").setAllowedOrigins(clipCascadeProperties.getAllowedOrigins());
    }

    // Scheduler for WebSocket heartbeats
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
        int maxMessageSizeInBytes = clipCascadeProperties.getOverheadMaxMessageSizeInBytes();

        ServletServerContainerFactoryBean factory = new ServletServerContainerFactoryBean();
        factory.setMaxTextMessageBufferSize(maxMessageSizeInBytes);
        factory.setMaxBinaryMessageBufferSize(maxMessageSizeInBytes);
        return factory;
    }

    // STOMP settings
    @Override
    public void configureWebSocketTransport(@SuppressWarnings("null") WebSocketTransportRegistration registration) {
        int maxMessageSizeInBytes = clipCascadeProperties.getOverheadMaxMessageSizeInBytes();

        registration.setMessageSizeLimit(maxMessageSizeInBytes); // default : 64 * 1024
        registration.setSendTimeLimit(20 * 10000); // default : 10 * 10000
        registration.setSendBufferSizeLimit(maxMessageSizeInBytes); // default : 512 * 1024
    }
}
