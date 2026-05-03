package com.acme.clipcascade.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.session.SessionRegistry;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.session.HttpSessionEventPublisher;
import org.springframework.session.FindByIndexNameSessionRepository;
import org.springframework.session.Session;
import org.springframework.session.security.SpringSessionBackedSessionRegistry;
import com.acme.clipcascade.service.BruteForceProtectionService;
import com.acme.clipcascade.service.FacadeUserService;

@Configuration
@EnableWebSecurity
public class SecurityConfiguration {

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

	// Replaces the in-memory SessionRegistryImpl with a registry backed by
	// the Spring Session repository, so server-side session state survives a
	// restart and existing client cookies remain valid.
	@Bean
	public SessionRegistry sessionRegistry(
			FindByIndexNameSessionRepository<? extends Session> sessionRepository) {
		return new SpringSessionBackedSessionRegistry<>(sessionRepository);
	}

	// Ensures the SessionRegistry is notified of session lifecycle events
	@Bean
	public HttpSessionEventPublisher httpSessionEventPublisher() {
		return new HttpSessionEventPublisher();
	}

	@Bean
	public SecurityFilterChain securityFilterChain(
			HttpSecurity http,
			SessionRegistry sessionRegistry) throws Exception {
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
				.sessionManagement(session -> session
						.sessionCreationPolicy(SessionCreationPolicy.ALWAYS) // Always create a new session
						.maximumSessions(-1) // Allow unlimited sessions
						.sessionRegistry(sessionRegistry)
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
