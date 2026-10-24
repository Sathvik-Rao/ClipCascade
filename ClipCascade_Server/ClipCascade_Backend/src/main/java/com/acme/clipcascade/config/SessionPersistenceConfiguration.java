package com.acme.clipcascade.config;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
import java.time.Duration;
import java.util.EnumSet;

import javax.sql.DataSource;

import jakarta.servlet.DispatcherType;

import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.DependsOn;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.session.jdbc.JdbcIndexedSessionRepository;
import org.springframework.session.web.http.CookieHttpSessionIdResolver;
import org.springframework.session.web.http.DefaultCookieSerializer;
import org.springframework.session.web.http.SessionRepositoryFilter;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Opt-in session storage. Boot's automatic store selection is deliberately disabled. */
@Configuration(proxyBeanMethods = false)
public class SessionPersistenceConfiguration {

    @Bean
    InitializingBean sessionStorageInitializer(DataSource dataSource,
            @Value("${app.session.persistence.enabled:false}") boolean enabled) {
        return () -> {
            try (Connection connection = dataSource.getConnection()) {
                if (!enabled) {
                    // Do not let switching off and back on resurrect old authenticated sessions.
                    try (ResultSet tables = connection.getMetaData().getTables(
                            connection.getCatalog(), connection.getSchema(), null, new String[] { "TABLE" })) {
                        while (tables.next()) {
                            if ("SPRING_SESSION".equalsIgnoreCase(tables.getString("TABLE_NAME"))) {
                                new JdbcTemplate(dataSource).update("DELETE FROM SPRING_SESSION");
                                break;
                            }
                        }
                    }
                    return;
                }
                String database = connection.getMetaData().getDatabaseProductName();
                String platform = switch (database) {
                    case "H2" -> "h2";
                    case "PostgreSQL" -> "postgresql";
                    default -> throw new IllegalStateException(
                            "Persistent sessions support H2 and PostgreSQL, found: " + database);
                };
                // Use the framework's dialect-specific schema, made safe for repeated startups.
                String schema = new ClassPathResource("org/springframework/session/jdbc/schema-"
                        + platform + ".sql").getContentAsString(StandardCharsets.UTF_8)
                        .replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
                        .replace("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ")
                        .replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ")
                        .replace("PRINCIPAL_NAME VARCHAR(100)", "PRINCIPAL_NAME VARCHAR(255)");
                new ResourceDatabasePopulator(new ByteArrayResource(
                        schema.getBytes(StandardCharsets.UTF_8))).execute(dataSource);
            }
        };
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(name = "app.session.persistence.enabled", havingValue = "true")
    static class PersistentSessions {

        @Bean
        @DependsOn("sessionStorageInitializer")
        JdbcIndexedSessionRepository sessionRepository(DataSource dataSource,
                @Value("${server.servlet.session.timeout}") Duration timeout) {
            // Use independent transactions on the same JDBC connection source for session writes,
            // including when a request is changing an account in a JPA transaction.
            TransactionTemplate transactions = new TransactionTemplate(
                    new DataSourceTransactionManager(dataSource));
            transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            JdbcIndexedSessionRepository repository = new JdbcIndexedSessionRepository(
                    new JdbcTemplate(dataSource), transactions);
            repository.setDefaultMaxInactiveInterval(timeout);
            // Explicit logout must also revoke sessions configured with no inactivity limit.
            repository.setDeleteSessionQuery("DELETE FROM SPRING_SESSION WHERE SESSION_ID = ?");
            return repository;
        }

        @Bean
        FilterRegistrationBean<SessionRepositoryFilter<?>>
                persistentSessionFilter(JdbcIndexedSessionRepository repository) {
            DefaultCookieSerializer cookies = new DefaultCookieSerializer();
            cookies.setCookieName("JSESSIONID");
            cookies.setUseBase64Encoding(false);
            cookies.setUseHttpOnlyCookie(true);
            cookies.setSameSite("Lax");
            // Secure follows request.isSecure(), including a correctly configured HTTPS proxy.
            CookieHttpSessionIdResolver resolver = new CookieHttpSessionIdResolver();
            resolver.setCookieSerializer(cookies);
            SessionRepositoryFilter<?> filter =
                    new SessionRepositoryFilter<>(repository);
            filter.setHttpSessionIdResolver(resolver);
            FilterRegistrationBean<SessionRepositoryFilter<?>> registration =
                    new FilterRegistrationBean<>(filter);
            registration.setOrder(SessionRepositoryFilter.DEFAULT_ORDER);
            registration.setDispatcherTypes(EnumSet.of(
                    DispatcherType.REQUEST, DispatcherType.ASYNC, DispatcherType.ERROR));
            return registration;
        }
    }
}
