package com.acme.clipcascade.constants;

public class ServerConstants {
    // App version
    public static final String APP_VERSION = "3.0.0";

    // Version URL
    public static final String VERSION_URL = "https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/version.json";

    // Metadata URL
    public static final String METADATA_URL = "https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/metadata.json";

    // Help URL
    public static final String HELP_URL = "https://github.com/Sathvik-Rao/ClipCascade/blob/main/README.md";

    // Captcha Session ID
    public static final String CAPTCHA_SESSION_ID = "captcha_answer";

    // Captcha Case Sensitive
    public static final boolean CAPTCHA_CASE_SENSITIVE = false;

    // BFA Tracker Log Path
    public static final String BFA_TRACKER_LOG_PATH = "logs/bfa_tracker_logs";

    // BFA Tracker Cache Path
    public static final String BFA_TRACKER_CACHE_PATH = "database/bfa_tracker_cache";

    private ServerConstants() {
        // private constructor to prevent instantiation
    }
}
