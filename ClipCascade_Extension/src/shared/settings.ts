import { DEFAULT_HASH_ROUNDS } from "./constants";

export interface Settings {
  serverUrl: string;
  username: string;
  encryption: boolean;
  hashRounds: number;
  salt: string;
  /** Keep the login hash and encryption key across browser restarts. */
  rememberMe: boolean;
  /** Read the clipboard after copy/cut events in web pages. */
  captureBrowserCopies: boolean;
  /** Poll the system clipboard to catch copies made in other apps. */
  pollSystemClipboard: boolean;
  pollIntervalMs: number;
  /** Write received text straight to the clipboard. */
  autoCopyReceived: boolean;
  notifications: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: "",
  username: "",
  encryption: true,
  hashRounds: DEFAULT_HASH_ROUNDS,
  salt: "",
  rememberMe: false,
  captureBrowserCopies: true,
  pollSystemClipboard: false,
  pollIntervalMs: 1000,
  autoCopyReceived: true,
  notifications: true,
};

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("Server URL must start with http:// or https://");
  return trimmed;
}

export function toWebSocketUrl(serverUrl: string, endpoint: string): string {
  return serverUrl.replace(/^http/i, "ws") + endpoint;
}
