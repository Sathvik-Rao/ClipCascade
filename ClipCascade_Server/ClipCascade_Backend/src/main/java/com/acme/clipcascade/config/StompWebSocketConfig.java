package com.acme.clipcascade.config;

import org.springframework.lang.NonNull;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessageHandler;
import org.springframework.messaging.support.ExecutorChannelInterceptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.adapter.NativeWebSocketSession;
import org.springframework.web.socket.handler.WebSocketHandlerDecorator;
import org.springframework.web.socket.handler.WebSocketSessionDecorator;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

import jakarta.websocket.Session;
import org.apache.tomcat.websocket.Constants;

import com.acme.clipcascade.constants.ServerConstants;
import com.acme.clipcascade.service.LiveWebSocketService;
import com.acme.clipcascade.service.P2SDeliveryService;

@Configuration
@EnableWebSocketMessageBroker
@ConditionalOnProperty(prefix = "app.p2p", name = "enabled", havingValue = "false", matchIfMissing = false)
public class StompWebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private static final long SEND_STALL_TIMEOUT_MS = 60_000L;

    private final ClipCascadeProperties clipCascadeProperties;

    private final LiveWebSocketService liveWebSockets;
    private final ObjectProvider<P2SDeliveryService> delivery;

    public StompWebSocketConfig(ClipCascadeProperties clipCascadeProperties, LiveWebSocketService liveWebSockets, ObjectProvider<P2SDeliveryService> delivery) {
        this.clipCascadeProperties = clipCascadeProperties;
        this.liveWebSockets = liveWebSockets;
        this.delivery = delivery;
    }

    @Override
    public void configureClientInboundChannel(@NonNull ChannelRegistration registration) {
        registration.interceptors(new ExecutorChannelInterceptor() {
            @Override
            public Message<?> preSend(@NonNull Message<?> message, @NonNull MessageChannel channel) {
                StompHeaderAccessor headers = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
                if (headers == null) {
                    throw new AccessDeniedException("STOMP frame not allowed");
                }
                if (headers.isHeartbeat()) {
                    return message;
                }

                // Authorize the original client destination before Spring resolves user queues.
                var command = headers.getCommand();
                boolean allowed = command != null && switch (command) {
                    case SEND -> headers.getUser() != null && ("/app/cliptext".equals(headers.getDestination())
                            || "/app/clipbinary".equals(headers.getDestination()));
                    case SUBSCRIBE -> headers.getUser() != null
                            && "/user/queue/cliptext".equals(headers.getDestination());
                    case CONNECT, STOMP, DISCONNECT, UNSUBSCRIBE, ACK, NACK -> headers.getDestination() == null;
                    default -> false;
                };
                if (!allowed) {
                    throw new AccessDeniedException("STOMP frame not allowed");
                }
                P2SDeliveryService.recordCapabilities(headers);
                return message;
            }

            @Override
            public void afterMessageHandled(Message<?> message, MessageChannel channel,
                    MessageHandler handler, Exception failure) {
                if (failure != null) return;
                var headers = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
                if (headers == null) return;
                if (headers.getCommand() == org.springframework.messaging.simp.stomp.StompCommand.SUBSCRIBE
                        && handler instanceof org.springframework.messaging.simp.user.UserDestinationMessageHandler) {
                    delivery.getObject().subscriptionReady(headers);
                } else if (headers.getCommand() == org.springframework.messaging.simp.stomp.StompCommand.UNSUBSCRIBE
                        && handler instanceof org.springframework.messaging.simp.broker.AbstractBrokerMessageHandler) {
                    delivery.getObject().subscriptionRemoved(headers);
                }
            }
        });
    }

    @Override
    public void configureMessageBroker(@NonNull MessageBrokerRegistry config) {
        // Prefix for client-to-server communication (application-level messages).
        // Clients send messages to server endpoints starting with "/app".
        config.setApplicationDestinationPrefixes("/app");
        // Clipboard revisions must reach each recipient in the order published.
        config.setPreservePublishOrder(true);

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
                    .setHeartbeatValue(new long[] {
                            ServerConstants.HEARTBEAT_SEND_INTERVAL_P2S,
                            ServerConstants.HEARTBEAT_RECEIVE_INTERVAL_P2S }) // Heartbeat intervals in milliseconds {
                                                                              // send, receive }
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
        registry.setPreserveReceiveOrder(true);
        registry.addEndpoint("/clipsocket")
                .addInterceptors(liveWebSockets.sessionHandshakeInterceptor())
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
        registration.addDecoratorFactory(liveWebSockets::decorate);
        registration.addDecoratorFactory(handler -> new WebSocketHandlerDecorator(handler) {
            @Override
            public void afterConnectionEstablished(WebSocketSession session) throws Exception {
                WebSocketSession transport = WebSocketSessionDecorator.unwrap(session);
                if (!(transport instanceof NativeWebSocketSession nativeSession)
                        || !(nativeSession.getNativeSession() instanceof Session jakartaSession)) {
                    throw new IllegalStateException("P2S requires a native Jakarta WebSocket session");
                }
                // Tomcat encodes outbound STOMP text in small buffer-sized writes.
                // Each successful piece gets a fresh blocking-write deadline, so
                // a slow transfer may continue without a whole-message deadline.
                jakartaSession.getUserProperties().put(
                        Constants.BLOCKING_SEND_TIMEOUT_PROPERTY, SEND_STALL_TIMEOUT_MS);
                super.afterConnectionEstablished(session);
            }
        });
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
         * Spring measures the whole send, not transport progress, and zero does NOT
         * disable this check. Use its largest supported value (about 24.8 days);
         * the native 60-second write-stall deadline above handles normal failures.
         * This leaves Spring's per-session queue/buffer protection in place.
         */
        registration.setSendTimeLimit(Integer.MAX_VALUE);

        /*
         * [SEND][EACH CONNECTION]
         * Configures the buffer size (in bytes) used for sending queued messages. If
         * the buffer exceeds this limit, the connection is terminated, and
         * a warning is logged.
         * This occurs again when a new message arrives.
         */
        registration
                .setSendBufferSizeLimit(maxMessageSizeInBytes); // default : 512 * 1024
    }

}
