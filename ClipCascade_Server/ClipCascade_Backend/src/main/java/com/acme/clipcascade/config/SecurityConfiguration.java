package com.acme.clipcascade.config;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.session.jdbc.JdbcIndexedSessionRepository;
import org.springframework.session.security.SpringSessionBackedSessionRegistry;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.core.session.SessionRegistryImpl;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.logout.SimpleUrlLogoutSuccessHandler;
import org.springframework.security.web.session.HttpSessionEventPublisher;
import com.acme.clipcascade.service.BruteForceProtectionService;
import com.acme.clipcascade.service.FacadeUserService;
import com.acme.clipcascade.service.LiveWebSocketService;

@Configuration
@EnableWebSecurity
public class SecurityConfiguration {
	private static final String LOGOUT_LOGIN_ID = SecurityConfiguration.class.getName() + ".logoutLoginId";

	private final UserDetailsService userDetailsService; // <- Spring Security UserDetailsService
	private final BCryptPasswordEncoder bCryptPasswordEncoder;
	private final BruteForceProtectionService bruteForceProtectionService;
	private final FacadeUserService facadeUserService;

	SecurityConfiguration(
			UserDetailsService userDetailsService,
			BCryptPasswordEncoder bCryptPasswordEncoder,
			BruteForceProtectionService bruteForceProtectionService,
			FacadeUserService facadeUserService) {

		this.userDetailsService = userDetailsService;
		this.bCryptPasswordEncoder = bCryptPasswordEncoder;
		this.bruteForceProtectionService = bruteForceProtectionService;
		this.facadeUserService = facadeUserService;
	}

	// SessionRegistry bean to store session information
	@Bean
	public SessionRegistry sessionRegistry(ObjectProvider<JdbcIndexedSessionRepository> repositories) {
		JdbcIndexedSessionRepository repository = repositories.getIfAvailable();
		return repository == null ? new SessionRegistryImpl()
				: new SpringSessionBackedSessionRegistry<>(repository);
	}

	// Ensures the SessionRegistry is notified of session lifecycle events
	@Bean
	public HttpSessionEventPublisher httpSessionEventPublisher() {
		return new HttpSessionEventPublisher();
	}

	@Bean
	public SecurityFilterChain securityFilterChain(HttpSecurity http, SessionRegistry sessionRegistry,
			LiveWebSocketService liveWebSockets) throws Exception {
		var logoutRedirect = new SimpleUrlLogoutSuccessHandler();
		logoutRedirect.setDefaultTargetUrl("/login?logout");
		return http
				.authorizeHttpRequests((authorize) -> authorize
						.requestMatchers(
								"/login",
								"/logout",
								"/signup",
								"/captcha",
								"/help",
								"/donate",
								"/health",
								"/ping",
								"/assets/**")
						.permitAll() // <- Allow access to these URLs without authentication
						.anyRequest().authenticated()) // All other requests require authentication
				.formLogin(form -> form
						.loginPage("/login") // <- custom login URL
						.failureUrl("/login?error") // <- Where to go if login fails
						.successHandler(
								new CustomAuthenticationSuccessHandler(
										bruteForceProtectionService,
										facadeUserService))) // <- Custom authentication success handler
				.logout(logout -> logout
						.logoutUrl("/logout") // The URL to submit a logout request
						.addLogoutHandler((request, response, authentication) -> {
							var session = request.getSession(false);
							if (session != null) {
								request.setAttribute(LOGOUT_LOGIN_ID, session.getId());
							}
						})
						.logoutSuccessHandler((request, response, authentication) -> {
							// Spring Security has invalidated the HTTP session by this point.
							if (request.getAttribute(LOGOUT_LOGIN_ID) instanceof String loginId) {
								liveWebSockets.disconnectLogin(loginId);
							}
							logoutRedirect.onLogoutSuccess(request, response, authentication);
						}))
				.sessionManagement(session -> session
						.sessionCreationPolicy(SessionCreationPolicy.ALWAYS) // Always create a new session
						.maximumSessions(-1) // Allow unlimited sessions
						.sessionRegistry(sessionRegistry) // Use the session registry
						.expiredSessionStrategy(new CustomExpiredSession())) // Custom expired session strategy
				.build();
	}

	@Bean
	public AuthenticationProvider authenticationProvider() {
		DaoAuthenticationProvider provider = new DaoAuthenticationProvider();
		provider.setPasswordEncoder(bCryptPasswordEncoder);
		provider.setUserDetailsService(userDetailsService);
		return provider;
	}
}
