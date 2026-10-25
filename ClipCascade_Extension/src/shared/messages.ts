import type { Clip, ClipType } from "./clip";
import type { Settings } from "./settings";

export type ConnectionStatus = "signedOut" | "connecting" | "connected" | "disconnected";

/** State of the websocket held by the offscreen document. */
export type SocketStatus = "idle" | "connecting" | "connected" | "disconnected";

export interface HistoryItem {
  id: string;
  direction: "in" | "out";
  at: number;
  type: ClipType;
  summary: string;
  size: number;
  /** False once the content was dropped to stay within the storage budget. */
  available: boolean;
}

export interface State {
  status: ConnectionStatus;
  error?: string;
  username?: string;
  serverUrl?: string;
  maxSize?: number;
  settings: Settings;
  history: HistoryItem[];
}

/** Messages handled by the service worker. */
export type BackgroundRequest =
  | { type: "getState" }
  | { type: "login"; serverUrl: string; username: string; password: string; settings: Partial<Settings> }
  | { type: "logout" }
  | { type: "reconnect" }
  | { type: "updateSettings"; settings: Partial<Settings> }
  | { type: "sendClip"; clip: Clip }
  | { type: "sendClipboardNow" }
  | { type: "clearHistory" }
  | { type: "getHistoryClip"; id: string }
  /** Sent by the popup before it writes to the clipboard, so the write is not synced back. */
  | { type: "expectWrite"; clip: Clip }
  | { type: "copyEvent" }
  // From the offscreen document:
  | { type: "clipboardChanged"; clip: Clip }
  | { type: "clipboardTooLarge"; size: number }
  /** Before each websocket (re)connect; answers whether to go ahead. */
  | { type: "prepareConnect" }
  | { type: "socketStatus"; status: SocketStatus; reason?: string }
  | { type: "socketMessage"; body: string };

/** Messages handled by the offscreen document. */
export type OffscreenRequest =
  | { target: "offscreen"; type: "configure"; poll: boolean; intervalMs: number; maxSize: number }
  | { target: "offscreen"; type: "check" }
  | { target: "offscreen"; type: "read" }
  | { target: "offscreen"; type: "writeText"; text: string }
  | { target: "offscreen"; type: "expectWrite"; clip: Clip }
  | { target: "offscreen"; type: "connect"; url: string }
  | { target: "offscreen"; type: "disconnect" }
  | { target: "offscreen"; type: "publish"; body: string }
  | { target: "offscreen"; type: "waitConnected"; timeoutMs: number };

/** Broadcast to open extension pages. */
export type Broadcast = { type: "stateChanged"; state: State };

export type Response<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };
