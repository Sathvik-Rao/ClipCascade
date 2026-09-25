// Mirrors ClipCascade_Desktop/src/core/constants.py
export const LOGIN_URL = "/login";
export const LOGOUT_URL = "/logout";
export const CSRF_URL = "/csrf-token";
export const VALIDATE_SESSION_URL = "/validate-session";
export const SERVER_MODE_URL = "/server-mode";
export const MAXSIZE_URL = "/max-size";
export const WEBSOCKET_ENDPOINT = "/clipsocket";
export const SUBSCRIPTION_DESTINATION = "/user/queue/cliptext";
export const SEND_DESTINATION = "/app/cliptext";

export const DEFAULT_MAX_SIZE = 1048576; // 1 MiB
export const DEFAULT_HASH_ROUNDS = 664937;
export const RECONNECT_DELAY_MS = 10_000;
export const HEARTBEAT_MS = 20_000; // matches the server's P2S send interval

export const HISTORY_LIMIT = 20;
export const HISTORY_MAX_BYTES = 8 * 1024 * 1024; // chrome.storage.session holds 10 MB
