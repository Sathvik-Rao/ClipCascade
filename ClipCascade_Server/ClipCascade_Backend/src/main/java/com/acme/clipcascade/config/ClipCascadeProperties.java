package com.acme.clipcascade.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ClipCascadeProperties {

    /*
     * Maximum transmission message size in MiB (default: 1 MiB)
     * Note: Ensure configuration is included in the activemq.xml file as well.
     */
    @Value("${CC_MAX_MESSAGE_SIZE_IN_MiB:1}")
    private int maxMessageSizeInMiB;

    /*
     * Maximum transmission message size in bytes (default: 0 bytes)
     * If set to greater than 0, overrides CC_MAX_MESSAGE_SIZE_IN_MiB
     * Note: Ensure configuration is included in the activemq.xml file as well.
     */
    @Value("${CC_MAX_MESSAGE_SIZE_IN_BYTES:0}")
    private long maxMessageSizeInBytes;

    // Allowed origins for WebSocket connections (default: all origins '*')
    @Value("${CC_ALLOWED_ORIGINS:*}")
    private String allowedOrigins;

    // Flag to enable or disable signup form (default: false)
    @Value("${CC_SIGNUP_ENABLED:false}")
    private boolean signupEnabled;

    /*
     * Maximum number of repeated failed attempts for unique IP addresses allowed
     * before lockout (default: 15)
     */
    @Value("${CC_MAX_UNIQUE_IP_ATTEMPTS:15}")
    private int maxUniqueIpAttempts;

    /*
     * Maximum number of repeated failed attempts allowed per IP before lockout
     * (default: 30)
     */
    @Value("${CC_MAX_ATTEMPTS_PER_IP:30}")
    private int maxAttemptsPerIp;

    // Lock timeout duration in seconds (default: 60 seconds)
    @Value("${CC_LOCK_TIMEOUT_SECONDS:60}")
    private int lockTimeoutSeconds;

    /**
     * Lock timeout scaling factor (applied per IP address).
     *
     * This factor determines how the lockout duration increases with each repeated
     * failed attempt. The lockout time grows proportionally based on the configured
     * scaling factor and the initial lockout duration. (default: 2)
     *
     * Example Scenarios:
     * - If LOCK_TIMEOUT_SECONDS = 60 and LOCK_TIMEOUT_SCALING_FACTOR = 1:
     * Lockout times: 60, 120, 180, 240, 300, 360 seconds.
     *
     * - If LOCK_TIMEOUT_SECONDS = 60 and LOCK_TIMEOUT_SCALING_FACTOR = 2:
     * Lockout times: 120, 240, 360, 480, 600, 720 seconds.
     *
     * - If LOCK_TIMEOUT_SECONDS = 60 and LOCK_TIMEOUT_SCALING_FACTOR = 3:
     * Lockout times: 180, 360, 540, 720, 900, 1080 seconds.
     */
    @Value("${CC_LOCK_TIMEOUT_SCALING_FACTOR:2}")
    private int lockTimeoutScalingFactor;

    /*
     * Account purge timeout duration in seconds after which inactive accounts are
     * purged [default: -1, no purge]
     * 
     * Example:
     * [63115200 seconds, 2 years(session timeout + 1 year)]
     * last login time or creation time: 1736287410
     * purge time: 1736287410 + 63115200 = 1799402610
     */
    @Value("${CC_ACCOUNT_PURGE_TIMEOUT_SECONDS:-1}")
    private long accountPurgeTimeoutSeconds;

    /*
     * Maximum number of user accounts allowed (default: -1, unlimited)
     */
    @Value("${CC_MAX_USER_ACCOUNTS:-1}")
    private long maxUserAccounts;

    /*
     * Flag to enable or disable logging of brute force tracker on shutdown
     * (default: false)
     */
    @Value("${CC_LOG_BRUTE_FORCE_TRACKER_ENABLED:false}")
    private boolean logBruteForceTrackerEnabled;

    /*
     * Flag to enable or disable external STOMP broker (default: false)
     */
    @Value("${CC_EXTERNAL_BROKER_ENABLED:false}")
    private boolean externalBrokerEnabled;

    /*
     * External STOMP broker host (default: localhost)
     */
    @Value("${CC_BROKER_HOST:localhost}")
    private String brokerHost;

    /*
     * External STOMP broker port (default: 61613)
     */
    @Value("${CC_BROKER_PORT:61613}")
    private int brokerPort;

    /*
     * External STOMP broker username (default: admin)
     * Note: Ensure configuration is included in the activemq.xml file as well.
     */
    @Value("${CC_BROKER_USERNAME:admin}")
    private String brokerUsername;

    /*
     * External STOMP broker password (default: admin)
     * Note: Ensure configuration is included in the activemq.xml file as well.
     */
    @Value("${CC_BROKER_PASSWORD:admin}")
    private String brokerPassword;

    /*
     * Flag to enable or disable BFA cache (default: false)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_BFA_CACHE_ENABLED:false}")
    private boolean bfaCacheEnabled;

    /*
     * BFA Tracker Cache max jvm(RAM) entries (default: 50)
     */
    @Value("${CC_BFA_TRACKER_CACHE_MAX_JVM_ENTRIES:50}")
    private int bfaTrackerCacheMaxJvmEntries;

    /*
     * BFA Tracker Cache RAM(heap) percentage (default: 0)
     */
    @Value("${CC_BFA_TRACKER_CACHE_RAM_PERCENTAGE:0}")
    private int bfaTrackerCacheRamPercentage;

    /*
     * BFA Tracker Cache disk percentage (default: 40)
     */
    @Value("${CC_BFA_TRACKER_CACHE_DISK_PERCENTAGE:40}")
    private int bfaTrackerCacheDiskPercentage;

    /*
     * Server logging level (default: INFO)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     * 
     * Available Levels:
     * TRACE (most detailed)
     * DEBUG
     * INFO (default)
     */
    @Value("${CC_SERVER_LOGGING_LEVEL:INFO}")
    private String serverLoggingLevel;

    /*
     * Server logging history max days (default: 30 days)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_SERVER_LOG_HISTORY_MAX_DAYS:30}")
    private int serverLogHistoryMaxDays;

    /*
     * Server logging max capacity (default: 1GB)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_SERVER_LOG_MAX_CAPACITY:1GB}")
    private String serverLogMaxCapacity;

    /*
     * Server database username (default: clipcascade)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_SERVER_DB_USERNAME:clipcascade}")
    private String serverDbUsername;

    /*
     * Server database host (default: QjuGlhE3uwylBBANMkX1 o2MdEoFgbU5XkFvTftky)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     * 
     * <file password> and <user password> are for h2 file database
     */
    @Value("${CC_SERVER_DB_PASSWORD:QjuGlhE3uwylBBANMkX1 o2MdEoFgbU5XkFvTftky}")
    private String serverDbPassword;

    /*
     * Server database URL (default:
     * jdbc:h2:file:./database/clipcascade;CIPHER=AES;MODE=PostgreSQL)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_SERVER_DB_URL:jdbc:h2:file:./database/clipcascade;CIPHER=AES;MODE=PostgreSQL}")
    private String serverDbUrl;

    /*
     * Server database driver (default: org.h2.Driver)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_SERVER_DB_DRIVER:org.h2.Driver}")
    private String serverDbDriver;

    /*
     * Server database dialect (default: org.hibernate.dialect.H2Dialect)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_SERVER_DB_HIBERNATE_DIALECT:org.hibernate.dialect.H2Dialect}")
    private String serverDbHibernateDialect;

    /*
     * Server port (default: 8080)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_PORT:8080}")
    private int port;

    /*
     * Server Session timeout (default: 525960m)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_SESSION_TIMEOUT:525960m}")
    private String sessionTimeout;

    /*
     * Server P2P enabled (default: false)
     * note: Ensure configuration is included in the application.properties file as
     * well.
     */
    @Value("${CC_P2P_ENABLED:false}")
    private boolean p2pEnabled;

    /*
     * Server P2P STUN URL (default: stun:stun.l.google.com:19302)
     */
    @Value("${CC_P2P_STUN_URL:stun:stun.l.google.com:19302}")
    private String p2pStunUrl;

    /*
     * Maximum number of global WebSocket connections allowed (default: -1 for
     * unlimited).
     * Supported only in P2P mode.
     * Note: This value represents the total maximum connections across all users.
     */
    @Value("${CC_MAX_WS_GLOBAL_CONNECTIONS:-1}")
    private long maxWsGlobalConnections;

    /*
     * Maximum number of WebSocket connections allowed per user (default: -1 for
     * unlimited).
     * Supported only in P2P mode.
     * Note: This value represents the maximum connections allowed per individual
     * user.
     */
    @Value("${CC_MAX_WS_CONNECTIONS_PER_USER:-1}")
    private long maxWsConnectionsPerUser;

    /*
     * Donations enabled (default: false)
     */
    @Value("${CC_DONATIONS_ENABLED:false}")
    private boolean donationsEnabled;

    private long getMessageSizeInBytes() {
        /*
         * Note: Ensure that the same logic is applied in the activemq.xml file as well.
         */
        return maxMessageSizeInBytes > 0
                ? maxMessageSizeInBytes
                : (maxMessageSizeInMiB > 0 ? maxMessageSizeInMiB : 1) << 20;
    }

    public double getMaxMessageSizeInMiB() {
        double sizeInMiB = getMessageSizeInBytes() / (double) (1 << 20);
        return Math.floor(sizeInMiB * 100) / 100; // round to 2 decimal places
    }

    public long getMaxMessageSizeInBytes() {
        return getMessageSizeInBytes();
    }

    public long getOverheadMaxMessageSizeInBytes() {
        /*
         * Double the size to account for base64 overhead (for data and encryption
         * encoding)
         */
        return (getMessageSizeInBytes() * 2);
    }

    public String getAllowedOrigins() {
        return allowedOrigins;
    }

    public boolean isSignupEnabled() {
        return signupEnabled;
    }

    public boolean getSignupEnabled() {
        return signupEnabled;
    }

    public int getMaxUniqueIpAttempts() {
        return maxUniqueIpAttempts;
    }

    public int getMaxAttemptsPerIp() {
        return maxAttemptsPerIp;
    }

    public int getLockTimeoutSeconds() {
        return lockTimeoutSeconds;
    }

    public int getLockTimeoutScalingFactor() {
        return lockTimeoutScalingFactor;
    }

    public long getAccountPurgeTimeoutSeconds() {
        return accountPurgeTimeoutSeconds;
    }

    public long getMaxUserAccounts() {
        return maxUserAccounts;
    }

    public boolean isLogBruteForceTrackerEnabled() {
        return logBruteForceTrackerEnabled;
    }

    public boolean getLogBruteForceTrackerEnabled() {
        return logBruteForceTrackerEnabled;
    }

    public boolean isExternalBrokerEnabled() {
        return externalBrokerEnabled;
    }

    public boolean getExternalBrokerEnabled() {
        return externalBrokerEnabled;
    }

    public String getBrokerHost() {
        return brokerHost;
    }

    public int getBrokerPort() {
        return brokerPort;
    }

    public String getBrokerUsername() {
        return brokerUsername;
    }

    public String getBrokerPassword() {
        return brokerPassword;
    }

    public boolean isBfaCacheEnabled() {
        return bfaCacheEnabled;
    }

    public boolean getBfaCacheEnabled() {
        return bfaCacheEnabled;
    }

    public int getBfaTrackerCacheMaxJvmEntries() {
        return bfaTrackerCacheMaxJvmEntries;
    }

    public int getBfaTrackerCacheRamPercentage() {
        return bfaTrackerCacheRamPercentage;
    }

    public int getBfaTrackerCacheDiskPercentage() {
        return bfaTrackerCacheDiskPercentage;
    }

    public String getServerLoggingLevel() {
        return serverLoggingLevel;
    }

    public int getServerLogHistoryMaxDays() {
        return serverLogHistoryMaxDays;
    }

    public String getServerLogMaxCapacity() {
        return serverLogMaxCapacity;
    }

    public String getServerDbUsername() {
        return serverDbUsername;
    }

    public String getServerDbPassword() {
        return serverDbPassword;
    }

    public String getServerDbUrl() {
        return serverDbUrl;
    }

    public String getServerDbDriver() {
        return serverDbDriver;
    }

    public String getServerDbHibernateDialect() {
        return serverDbHibernateDialect;
    }

    public int getPort() {
        return port;
    }

    public String getSessionTimeout() {
        return sessionTimeout;
    }

    public boolean isP2pEnabled() {
        return p2pEnabled;
    }

    public boolean getP2pEnabled() {
        return p2pEnabled;
    }

    public String getP2pStunUrl() {
        return p2pStunUrl;
    }

    public long getMaxWsGlobalConnections() {
        return maxWsGlobalConnections;
    }

    public long getMaxWsConnectionsPerUser() {
        return maxWsConnectionsPerUser;
    }

    public boolean isDonationsEnabled() {
        return donationsEnabled;
    }

    public boolean getDonationsEnabled() {
        return donationsEnabled;
    }

    @Override
    public String toString() {
        return "{\n" +
                " maxMessageSizeInMiB='" + getMaxMessageSizeInMiB() + "'" +
                ",\n maxMessageSizeInBytes='" + getMaxMessageSizeInBytes() + "'" +
                ",\n allowedOrigins='" + getAllowedOrigins() + "'" +
                ",\n signupEnabled='" + isSignupEnabled() + "'" +
                ",\n maxUniqueIpAttempts='" + getMaxUniqueIpAttempts() + "'" +
                ",\n maxAttemptsPerIp='" + getMaxAttemptsPerIp() + "'" +
                ",\n lockTimeoutSeconds='" + getLockTimeoutSeconds() + "'" +
                ",\n lockTimeoutScalingFactor='" + getLockTimeoutScalingFactor() + "'" +
                ",\n accountPurgeTimeoutSeconds='" + getAccountPurgeTimeoutSeconds() + "'" +
                ",\n maxUserAccounts='" + getMaxUserAccounts() + "'" +
                ",\n logBruteForceTrackerEnabled='" + isLogBruteForceTrackerEnabled() + "'" +
                ",\n externalBrokerEnabled='" + isExternalBrokerEnabled() + "'" +
                ",\n brokerHost='" + getBrokerHost() + "'" +
                ",\n brokerPort='" + getBrokerPort() + "'" +
                ",\n bfaCacheEnabled='" + isBfaCacheEnabled() + "'" +
                ",\n bfaTrackerCacheMaxJvmEntries='" + getBfaTrackerCacheMaxJvmEntries() + "'" +
                ",\n bfaTrackerCacheRamPercentage='" + getBfaTrackerCacheRamPercentage() + "'" +
                ",\n bfaTrackerCacheDiskPercentage='" + getBfaTrackerCacheDiskPercentage() + "'" +
                ",\n serverLoggingLevel='" + getServerLoggingLevel() + "'" +
                ",\n serverLogHistoryMaxDays='" + getServerLogHistoryMaxDays() + "'" +
                ",\n serverLogMaxCapacity='" + getServerLogMaxCapacity() + "'" +
                ",\n serverDbUrl='" + getServerDbUrl() + "'" +
                ",\n serverDbDriver='" + getServerDbDriver() + "'" +
                ",\n serverDbHibernateDialect='" + getServerDbHibernateDialect() + "'" +
                ",\n port='" + getPort() + "'" +
                ",\n sessionTimeout='" + getSessionTimeout() + "'" +
                ",\n p2pEnabled='" + isP2pEnabled() + "'" +
                ",\n p2pStunUrl='" + getP2pStunUrl() + "'" +
                ",\n maxWsGlobalConnections='" + getMaxWsGlobalConnections() + "'" +
                ",\n maxWsConnectionsPerUser='" + getMaxWsConnectionsPerUser() + "'" +
                "\n}";
    }

}
