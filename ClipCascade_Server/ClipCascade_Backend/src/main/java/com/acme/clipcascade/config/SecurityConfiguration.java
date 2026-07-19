package com.acme.clipcascade.config;

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
import org.springframework.security.web.session.HttpSessionEventPublisher;
import com.acme.clipcascade.service.BruteForceProtectionService;
import com.acme.clipcascade.service.FacadeUserService;

@Configuration
@EnableWebSecurity
public class SecurityConfiguration {

	private final UserDetailsService userDetailsService; // <- Spring Security UserDetailsService
	private final BCryptPasswordEncoder bCryptPasswordEncoder;
	private final BruteForceProtectionService bruteForceProtectionService;
	private final FacadeUserService facadeUserService;
	private final ClipCascadeProperties clipCascadeProperties;

	SecurityConfiguration(
			UserDetailsService userDetailsService,
			BCryptPasswordEncoder bCryptPasswordEncoder,
			BruteForceProtectionService bruteForceProtectionService,
			FacadeUserService facadeUserService,
			ClipCascadeProperties clipCascadeProperties) {

		this.userDetailsService = userDetailsService;
		this.bCryptPasswordEncoder = bCryptPasswordEncoder;
		this.bruteForceProtectionService = bruteForceProtectionService;
		this.facadeUserService = facadeUserService;
		this.clipCascadeProperties = clipCascadeProperties;
	}

	/**
	 * connect-src value: 'self' plus every configured origin.
	 *
	 * The WebSocket lives on the same origins the operator already lists in
	 * CC_ALLOWED_ORIGINS, so naming them keeps the socket working while leaving
	 * CSP able to block a connection to anywhere else. Bare "ws: wss:" allowed
	 * any host at all.
	 */
	private String connectSrcOrigins() {
		StringBuilder value = new StringBuilder("'self'");
		for (String origin : clipCascadeProperties.getAllowedOriginsArray()) {
			if (origin == null || origin.isBlank()) {
				continue;
			}
			value.append(' ').append(origin.trim());
			// The socket uses the ws(s) scheme against the same host.
			if (origin.startsWith("https://")) {
				value.append(' ').append("wss://").append(origin.substring("https://".length()));
			} else if (origin.startsWith("http://")) {
				value.append(' ').append("ws://").append(origin.substring("http://".length()));
			}
		}
		return value.toString();
	}

	// SessionRegistry bean to store session information
	@Bean
	public SessionRegistry sessionRegistry() {
		return new SessionRegistryImpl();
	}

	// Ensures the SessionRegistry is notified of session lifecycle events
	@Bean
	public HttpSessionEventPublisher httpSessionEventPublisher() {
		return new HttpSessionEventPublisher();
	}

	@Bean
	public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
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
						.logoutSuccessUrl("/login?logout")) // Where to go after successful logout
				.headers(headers -> headers
						.contentSecurityPolicy(csp -> csp.policyDirectives(
								// Scripts are external-only (no unsafe-inline). Inline styles remain for legacy templates.
								// connect-src names the configured origins rather than bare ws:/wss:,
								// which would have allowed a socket to any host and removed CSP as an
								// exfiltration backstop.
								"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src "
										+ connectSrcOrigins()
										+ "; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"))
						.referrerPolicy(referrer -> referrer.policy(
								org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy.NO_REFERRER)))
				.sessionManagement(session -> session
						.sessionCreationPolicy(SessionCreationPolicy.ALWAYS) // Always create a new session
						.maximumSessions(-1) // Allow unlimited sessions
						.sessionRegistry(sessionRegistry()) // Use the session registry
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
