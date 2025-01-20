package com.acme.clipcascade.config;

import org.springframework.lang.NonNull;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
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
@ConditionalOnProperty(prefix = "app.p2p", name = "enabled", havingValue = "false", matchIfMissing = false)
public class StompWebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private final ClipCascadeProperties clipCascadeProperties;

    public StompWebSocketConfig(ClipCascadeProperties clipCascadeProperties) {
        this.clipCascadeProperties = clipCascadeProperties;
    }

    @Override
    public void configureMessageBroker(@NonNull MessageBrokerRegistry config) {
        // Prefix for client-to-server communication (application-level messages).
        // Clients send messages to server endpoints starting with "/app".
        config.setApplicationDestinationPrefixes("/app");

        // Prefix for user-specific destinations.
        // Used when sending messages to specific users via "/user/{sessionId}/...".
        config.setUserDestinationPrefix("/user");

        if (!clipCascadeProperties.isExternalBrokerEnabled()) {
            /**
             * Enables a simple in-memory message broker to handle subscription-based
             * messaging.
             * - Subscriptions (sending messages to users) are created with prefixes like:
             * "/user/{sessionId}/queue/.." for user-specific destinations.
             */
            config.enableSimpleBroker("/queue") // <- destination
                    .setHeartbeatValue(new long[] { 20000, 0 }) // Heartbeat intervals in milliseconds { send, receive }
                    .setTaskScheduler(heartbeatTaskScheduler()); // Scheduler for heartbeats
        } else {
            /**
             * Enables external message broker to handle subscription-based
             * messaging.
             * - Subscriptions (sending messages to users) are created with prefixes like:
             * "/user/{sessionId}/queue/.." for user-specific destinations.
             */
            config
                    .enableStompBrokerRelay("/queue") // <- destination
                    .setRelayHost(clipCascadeProperties.getBrokerHost()) // <- hostname
                    .setRelayPort(clipCascadeProperties.getBrokerPort()) // <- port
                    .setSystemLogin(clipCascadeProperties.getBrokerUsername()) // <- system username
                    .setSystemPasscode(clipCascadeProperties.getBrokerPassword()) // <- system password
                    .setClientLogin(clipCascadeProperties.getBrokerUsername()) // <- client username
                    .setClientPasscode(clipCascadeProperties.getBrokerPassword()); // <- client password
        }
    }

    @Override
    public void registerStompEndpoints(@NonNull StompEndpointRegistry registry) {
        // Clients will connect to this endpoint for WebSocket communication.
        registry.addEndpoint("/clipsocket")
                .setAllowedOrigins(clipCascadeProperties.getAllowedOrigins());
    }

    // Scheduler for WebSocket heartbeats
    @Bean
    public TaskScheduler heartbeatTaskScheduler() {
        ThreadPoolTaskScheduler taskScheduler = new ThreadPoolTaskScheduler();
        taskScheduler.setPoolSize(1); // <- default: 1
        taskScheduler.setThreadNamePrefix("WebSocketHeartbeat-");
        return taskScheduler;
    }

    // server-level WebSocket settings.
    @Bean
    public ServletServerContainerFactoryBean servletServerContainerFactoryBean() {
        int maxMessageSizeInBytes = (int) clipCascadeProperties.getOverheadMaxMessageSizeInBytes();
        ServletServerContainerFactoryBean factory = new ServletServerContainerFactoryBean();

        /*
         * [RECEIVE/SEND][EACH CONNECTION]
         * Sets the maximum WebSocket message size (in bytes) allowed by the server
         * (Tomcat).
         * If a message exceeds this size, the connection is terminated without
         * displaying an error in the console, as this limit is enforced at the server
         * level.
         */
        factory.setMaxTextMessageBufferSize(maxMessageSizeInBytes); // default: 8 * 1024
        factory.setMaxBinaryMessageBufferSize(maxMessageSizeInBytes); // default : 8 * 1024

        return factory;
    }

    // STOMP WebSocket transport settings
    @Override
    public void configureWebSocketTransport(@SuppressWarnings("null") WebSocketTransportRegistration registration) {
        int maxMessageSizeInBytes = (int) clipCascadeProperties.getOverheadMaxMessageSizeInBytes();

        /*
         * [RECEIVE/SEND][EACH CONNECTION]
         * Sets the maximum WebSocket message size (in bytes) allowed by the transport
         * layer.
         * If a message exceeds this size, the connection is terminated, and an error is
         * displayed in the console.
         */
        registration.setMessageSizeLimit(maxMessageSizeInBytes); // default : 64 * 1024

        /*
         * [SEND][EACH CONNECTION]
         * Sets the timeout for sending messages. If an outgoing message exceeds this
         * time while a new message arrives, the connection is terminated, and a warning
         * is logged.
         */
        registration.setSendTimeLimit(200 * 1000); // default : 10 * 1000

        /*
         * [SEND][EACH CONNECTION]
         * Configures the buffer size (in bytes) used for sending queued messages. If
         * the buffer is full and the timeout expires, the connection is terminated, and
         * a warning is logged.
         * This occurs again when a new message arrives.
         */
        registration
                .setSendBufferSizeLimit(maxMessageSizeInBytes); // default : 512 * 1024
    }

}
