import { base64ToBytes, bytesToBase64 } from "../shared/base64";
import { clipHash, clipSize, clipSummary, clipToPayload, payloadToClip, type Clip } from "../shared/clip";
import { WEBSOCKET_ENDPOINT } from "../shared/constants";
import { tooLargeMessage } from "../shared/format";
import { decrypt, deriveKey, encrypt, importAesKey, sha3_512Hex } from "../shared/crypto";
import type { BackgroundRequest, Broadcast, ConnectionStatus, Response, SocketStatus, State } from "../shared/messages";
import {
  loadSettings,
  normalizeServerUrl,
  saveSettings,
  toWebSocketUrl,
  type Settings,
} from "../shared/settings";
import * as auth from "./auth";
import { applyWebSocketCookieRule, clearWebSocketCookieRule } from "./cookieRule";
import { addHistory, clearHistory, getHistoryClip, listHistory } from "./history";
import { callOffscreen, closeOffscreen, ensureOffscreen } from "./offscreen";

/** Signed-in session, kept in chrome.storage.session. */
interface Session {
  serverUrl: string;
  username: string;
  maxSize: number;
  /** Raw AES key (base64) when encryption is on. */
  keyB64?: string;
}

/** "Remember me" credentials in chrome.storage.local. Never the raw password. */
interface Remembered extends Session {
  passwordHash: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const COPY_EVENT_DELAY_MS = 100; // copy events fire before the clipboard is written
const ENCRYPTION_KEYS = ["serverUrl", "username", "encryption", "hashRounds", "salt"] as const;

let session: Session | null = null;
let aesKey: CryptoKey | null = null;
let status: ConnectionStatus = "signedOut";
let lastError: string | undefined;
/** The server echoes every message back to the sender; these are ours. */
const recentlySent: string[] = [];

// ---------------------------------------------------------------- state

async function getState(): Promise<State> {
  return {
    status,
    error: lastError,
    username: session?.username,
    serverUrl: session?.serverUrl,
    maxSize: session?.maxSize,
    settings: await loadSettings(),
    history: await listHistory(),
  };
}

function setStatus(next: ConnectionStatus, error?: string): void {
  status = next;
  lastError = error;
  const badge = { connected: "", connecting: "…", disconnected: "!", signedOut: "" }[next];
  void chrome.action.setBadgeText({ text: badge });
  void chrome.action.setBadgeBackgroundColor({ color: next === "disconnected" ? "#d93025" : "#5f6368" });
  void broadcast();
}

async function broadcast(): Promise<void> {
  const message: Broadcast = { type: "stateChanged", state: await getState() };
  // Rejects when no extension page is open.
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ---------------------------------------------------------------- session

async function activate(next: Session): Promise<void> {
  session = next;
  aesKey = next.keyB64 ? await importAesKey(base64ToBytes(next.keyB64)) : null;
  await ensureConnected({ reconfigure: true });
}

/**
 * Makes sure the offscreen document is up and holds a socket to the session's
 * server. Cheap when it already does, so it also runs on the keepalive alarm.
 */
async function ensureConnected({ reconfigure = false } = {}): Promise<void> {
  if (!session) return;
  if ((await ensureOffscreen()) || reconfigure) await configureOffscreen(await loadSettings());
  const socket = await callOffscreen<SocketStatus>({
    type: "connect",
    url: toWebSocketUrl(session.serverUrl, WEBSOCKET_ENDPOINT),
  });
  onSocketStatus(socket);
}

function onSocketStatus(socket: SocketStatus, reason?: string): void {
  if (!session) return;
  const next: ConnectionStatus = socket === "connected" || socket === "disconnected" ? socket : "connecting";
  if (next !== status || reason) setStatus(next, reason);
}

async function signIn(serverUrlInput: string, username: string, password: string, patch: Partial<Settings>) {
  const serverUrl = normalizeServerUrl(serverUrlInput);
  if (!username || !password) throw new Error("Enter a username and password");
  await closeOffscreen();
  session = null;
  setStatus("connecting");
  try {
    const settings = await saveSettings({ ...patch, serverUrl, username });
    const passwordHash = sha3_512Hex(password);
    await auth.login(serverUrl, username, passwordHash);
    if ((await auth.getServerMode(serverUrl)) === "P2P") {
      throw new Error("This server runs in P2P mode, which the extension does not support yet");
    }
    const keyB64 = settings.encryption
      ? bytesToBase64(await deriveKey(username, password, settings.salt, settings.hashRounds))
      : undefined;
    const next: Session = { serverUrl, username, maxSize: await auth.getMaxSize(serverUrl), keyB64 };
    await chrome.storage.session.set({ session: next });
    if (settings.rememberMe) {
      const remembered: Remembered = { ...next, passwordHash };
      await chrome.storage.local.set({ remembered });
    } else {
      await chrome.storage.local.remove("remembered");
    }
    await activate(next);
  } catch (e) {
    await signOut(errorMessage(e));
    throw e;
  }
  if (!(await callOffscreen<boolean>({ type: "waitConnected", timeoutMs: CONNECT_TIMEOUT_MS }))) {
    setStatus(
      "disconnected",
      "Signed in, but the websocket did not connect. If the server sets CC_ALLOWED_ORIGINS, " +
        `add ${location.origin} to it.`,
    );
  }
}

async function signOut(error?: string, { endServerSession = false } = {}): Promise<void> {
  const serverUrl = session?.serverUrl;
  session = null;
  aesKey = null;
  await closeOffscreen(); // also closes the socket
  await chrome.storage.session.remove("session");
  await chrome.storage.local.remove("remembered");
  await clearWebSocketCookieRule();
  await closeOffscreen();
  if (endServerSession && serverUrl) await auth.logout(serverUrl);
  setStatus("signedOut", error);
}

/** Before each websocket (re)connect: make sure the cookie is good and will be sent. */
async function ensureValidSession(): Promise<boolean> {
  if (!session) return false;
  const valid = await refreshSession(session);
  if (valid && session) await applyWebSocketCookieRule(session.serverUrl);
  return valid;
}

/** Checks the session cookie, logging in again with remembered credentials if it expired. */
async function refreshSession(current: Session): Promise<boolean> {
  if (await auth.validateSession(current.serverUrl)) return true;
  const { remembered } = (await chrome.storage.local.get("remembered")) as { remembered?: Remembered };
  if (remembered && remembered.serverUrl === current.serverUrl) {
    try {
      await auth.login(remembered.serverUrl, remembered.username, remembered.passwordHash);
      current.maxSize = await auth.getMaxSize(current.serverUrl);
      await chrome.storage.session.set({ session: current });
      return true;
    } catch (e) {
      // Offline or a server error: let the socket fail and retry on the next reconnect.
      if (!(e instanceof auth.CredentialsRejectedError)) return true;
    }
  } else {
    // Offline and expired look the same from here; only sign out when the server answers.
    const reachable = await fetch(current.serverUrl + "/ping", { cache: "no-store" }).then(
      (r) => r.ok,
      () => false,
    );
    if (!reachable) return true;
  }
  await signOut("Your session expired. Please sign in again.");
  notify("Signed out", "Your ClipCascade session expired. Open the extension to sign in again.");
  return false;
}

/** Restores the session after the service worker or the browser restarted. */
async function restore(): Promise<void> {
  const stored = (await chrome.storage.session.get("session")) as { session?: Session };
  if (stored.session) {
    await activate(stored.session);
    return;
  }
  const { remembered } = (await chrome.storage.local.get("remembered")) as { remembered?: Remembered };
  if (!remembered) return;
  // A fresh browser session: the cookie may be gone, ensureValidSession() re-logs in on connect.
  const { passwordHash: _hash, ...next } = remembered;
  await chrome.storage.session.set({ session: next });
  await activate(next);
}

// ---------------------------------------------------------------- clipboard

async function configureOffscreen(settings: Settings): Promise<void> {
  if (!session) return;
  await callOffscreen({
    type: "configure",
    poll: settings.pollSystemClipboard,
    intervalMs: settings.pollIntervalMs,
    maxSize: session.maxSize,
  });
}

async function send(clip: Clip): Promise<void> {
  if (!session) throw new Error("Sign in first");
  const size = clipSize(clip);
  if (size > session.maxSize) throw new Error(tooLargeMessage(size, session.maxSize));
  let payload = clipToPayload(clip);
  if (aesKey) payload = await encrypt(aesKey, payload);
  await callOffscreen({ type: "publish", body: JSON.stringify({ payload, type: clip.type }) });
  recentlySent.unshift(await clipHash(clip));
  recentlySent.length = Math.min(recentlySent.length, 5);
  await addHistory("out", clip);
  await broadcast();
}

async function receive(body: string): Promise<void> {
  const message = JSON.parse(body) as { payload?: unknown; type?: string };
  if (typeof message.payload !== "string") return;
  let payload = message.payload;
  if (aesKey) {
    try {
      payload = await decrypt(aesKey, payload);
    } catch {
      throw new Error("Could not decrypt a received clip. Encryption settings must match on all devices.");
    }
  } else if (looksEncrypted(payload)) {
    throw new Error("Received an encrypted clip. Turn on encryption (with the same settings) and sign in again.");
  }

  const clip = payloadToClip(payload, message.type);
  const hash = await clipHash(clip);
  const own = recentlySent.indexOf(hash);
  if (own !== -1) {
    recentlySent.splice(own, 1);
    return;
  }

  await addHistory("in", clip);
  await broadcast();
  const settings = await loadSettings();
  if (clip.type === "text" && settings.autoCopyReceived) {
    await callOffscreen({ type: "writeText", text: clip.text });
    notify("Copied to clipboard", clipSummary(clip, 120));
  } else if (clip.type === "text") {
    notify("Text received", clipSummary(clip, 120));
  } else {
    notify(clip.type === "image" ? "Image received" : "Files received", "Open ClipCascade to copy or save it.");
  }
}

function looksEncrypted(payload: string): boolean {
  if (!payload.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return ["nonce", "ciphertext", "tag"].every((k) => typeof parsed[k] === "string");
  } catch {
    return false;
  }
}

async function sendClipboardNow(): Promise<void> {
  const clip = await callOffscreen<Clip | null>({ type: "read" });
  if (!clip) throw new Error("The clipboard is empty or holds nothing that can be synced");
  await send(clip);
}

// ---------------------------------------------------------------- context menus, commands

async function imageUrlToPng(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  if (blob.type === "image/png") return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  const png = await canvas.convertToBlob({ type: "image/png" });
  return bytesToBase64(new Uint8Array(await png.arrayBuffer()));
}

function createContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "send-selection", title: "Send selection to ClipCascade", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "send-link", title: "Send link to ClipCascade", contexts: ["link"] });
    chrome.contextMenus.create({ id: "send-image", title: "Send image to ClipCascade", contexts: ["image"] });
    chrome.contextMenus.create({ id: "send-page", title: "Send page URL to ClipCascade", contexts: ["page"] });
  });
}

async function onContextMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  switch (info.menuItemId) {
    case "send-selection":
      if (info.selectionText) await send({ type: "text", text: info.selectionText });
      break;
    case "send-link":
      if (info.linkUrl) await send({ type: "text", text: info.linkUrl });
      break;
    case "send-page": {
      const url = info.pageUrl ?? tab?.url;
      if (url) await send({ type: "text", text: url });
      break;
    }
    case "send-image":
      if (info.srcUrl) await send({ type: "image", base64: await imageUrlToPng(info.srcUrl) });
      break;
  }
}

// ---------------------------------------------------------------- helpers

function notify(title: string, message: string): void {
  void loadSettings().then((settings) => {
    if (!settings.notifications) return;
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message: message || " ",
      silent: true,
    });
  });
}

function errorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === "TimeoutError") return "The server did not respond in time";
  if (e instanceof TypeError && /fetch/i.test(e.message)) return "Could not reach the server";
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------- message routing

async function handle(request: BackgroundRequest): Promise<unknown> {
  switch (request.type) {
    case "getState":
      return getState();
    case "login":
      await signIn(request.serverUrl, request.username, request.password, request.settings);
      return getState();
    case "logout":
      await signOut(undefined, { endServerSession: true });
      return getState();
    case "reconnect":
      if (session) {
        await callOffscreen({ type: "disconnect" }); // skip the retry backoff
        await ensureConnected();
      }
      return getState();
    case "updateSettings": {
      const current = await loadSettings();
      if (session && ENCRYPTION_KEYS.some((k) => k in request.settings && request.settings[k] !== current[k])) {
        throw new Error("Sign out before changing the server, account or encryption settings");
      }
      const settings = await saveSettings(request.settings);
      if (!settings.rememberMe) await chrome.storage.local.remove("remembered");
      await configureOffscreen(settings);
      await broadcast();
      return getState();
    }
    case "sendClip":
      await send(request.clip);
      return;
    case "sendClipboardNow":
      await sendClipboardNow();
      return;
    case "clearHistory":
      await clearHistory();
      await broadcast();
      return;
    case "getHistoryClip":
      return getHistoryClip(request.id);
    case "expectWrite":
      if (session) await callOffscreen({ type: "expectWrite", clip: request.clip });
      return;
    case "copyEvent":
      if (session && (await loadSettings()).captureBrowserCopies) {
        await new Promise((r) => setTimeout(r, COPY_EVENT_DELAY_MS));
        await callOffscreen({ type: "check" });
      }
      return;
    case "clipboardChanged":
      if (session) await send(request.clip);
      return;
    case "clipboardTooLarge":
      if (session) throw new Error(tooLargeMessage(request.size, session.maxSize));
      return;
    case "prepareConnect":
      return ensureValidSession();
    case "socketStatus":
      onSocketStatus(request.status, request.reason);
      return;
    case "socketMessage":
      if (session) await receive(request.body).catch((e) => setStatus(status, errorMessage(e)));
      return;
  }
}

/** Surfaces failures of background-initiated work (copy capture, menus) as notifications. */
function reportError(title: string) {
  return (e: unknown) => notify(title, errorMessage(e));
}

// Runs every time the service worker starts.
const ready = restore().catch((e) => setStatus("disconnected", errorMessage(e)));

chrome.runtime.onMessage.addListener((request: BackgroundRequest | { target?: string }, _sender, sendResponse) => {
  if ("target" in request && request.target) return false; // addressed to the offscreen document
  const req = request as BackgroundRequest;
  ready
    .then(() => handle(req))
    .then(
      (data) => sendResponse({ ok: true, data } satisfies Response<unknown>),
      (e) => {
        if (["clipboardChanged", "clipboardTooLarge", "copyEvent"].includes(req.type)) {
          reportError("Clipboard not synced")(e);
        }
        sendResponse({ ok: false, error: errorMessage(e) } satisfies Response);
      },
    );
  return true;
});

chrome.runtime.onInstalled.addListener(createContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void ready.then(() => onContextMenu(info, tab)).catch(reportError("Not sent"));
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "send-clipboard") void ready.then(sendClipboardNow).catch(reportError("Not sent"));
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  chrome.action.openPopup().catch(() => {});
});

// Recreates the offscreen document (and so the socket) if Chrome ever closed it.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  void ready.then(() => ensureConnected()).catch(() => {});
});
