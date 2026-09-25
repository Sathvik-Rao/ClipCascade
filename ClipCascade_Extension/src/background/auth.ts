import {
  CSRF_URL,
  DEFAULT_MAX_SIZE,
  LOGIN_URL,
  LOGOUT_URL,
  MAXSIZE_URL,
  SERVER_MODE_URL,
  VALIDATE_SESSION_URL,
} from "../shared/constants";

const REQUEST_TIMEOUT_MS = 15_000;

/** The server answered and refused the username/password (as opposed to being unreachable or failing). */
export class CredentialsRejectedError extends Error {}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    credentials: "include",
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
  });
}

/** Pulls the hidden `_csrf` field out of the server's login form. */
export function extractCsrfToken(html: string): string | undefined {
  for (const [input] of html.matchAll(/<input\b[^>]*>/gi)) {
    if (/\bname\s*=\s*["']_csrf["']/i.test(input)) {
      return /\bvalue\s*=\s*["']([^"']*)["']/i.exec(input)?.[1];
    }
  }
  return undefined;
}

/**
 * Form login, as done by the desktop client. On success the browser's cookie
 * jar holds the JSESSIONID that authenticates the websocket handshake.
 */
export async function login(serverUrl: string, username: string, passwordHash: string): Promise<void> {
  const page = await request(serverUrl + LOGIN_URL);
  if (!page.ok) throw new Error(`Could not load the login page (HTTP ${page.status})`);
  const csrf = extractCsrfToken(await page.text());
  if (!csrf) throw new Error("This does not look like a ClipCascade server (no login form found)");

  const res = await request(serverUrl + LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: passwordHash, _csrf: csrf }),
  });
  if (!res.ok) throw new Error(`Sign-in failed: the server returned HTTP ${res.status}`);
  // Success redirects to "/", failure (bad credentials or locked out) to "/login?error".
  if (new URL(res.url).pathname === LOGIN_URL) {
    throw new CredentialsRejectedError(
      "Sign-in failed: check the username and password (repeated failures lock the account for a while)",
    );
  }
  if (!(await validateSession(serverUrl))) {
    throw new Error("Signed in, but the session cookie was not kept");
  }
}

export async function validateSession(serverUrl: string): Promise<boolean> {
  try {
    const res = await request(serverUrl + VALIDATE_SESSION_URL);
    return res.ok && (await res.text()).trim() === "OK";
  } catch {
    return false;
  }
}

export async function getServerMode(serverUrl: string): Promise<string> {
  const res = await request(serverUrl + SERVER_MODE_URL);
  if (!res.ok) throw new Error(`Could not read the server mode (HTTP ${res.status})`);
  return ((await res.json()) as { mode?: string }).mode ?? "P2S";
}

export async function getMaxSize(serverUrl: string): Promise<number> {
  try {
    const res = await request(serverUrl + MAXSIZE_URL);
    if (res.ok) return ((await res.json()) as { maxsize?: number }).maxsize ?? DEFAULT_MAX_SIZE;
  } catch {
    // fall through to the default, like the desktop client
  }
  return DEFAULT_MAX_SIZE;
}

/** Ends the server session (best effort: local state is cleared regardless). */
export async function logout(serverUrl: string): Promise<void> {
  try {
    const res = await request(serverUrl + CSRF_URL);
    const { token } = (await res.json()) as { token?: string };
    if (token) {
      await request(serverUrl + LOGOUT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: token }),
      });
    }
  } catch {
    // ignore
  }
}
