// The offscreen document does the work the service worker can't:
// - clipboard access. Offscreen documents never have focus, so navigator.clipboard
//   is unavailable; execCommand("paste"/"copy") works thanks to the
//   clipboardRead/clipboardWrite permissions.
// - the websocket (see connection.ts). Frames are relayed to the service worker,
//   which owns sessions, encryption and history.
import { bytesToBase64 } from "../shared/base64";
import { clipHash, type Clip } from "../shared/clip";
import { tooLargeMessage } from "../shared/format";
import type { BackgroundRequest, OffscreenRequest, Response, SocketStatus } from "../shared/messages";
import { Connection } from "./connection";

const ADOPT_WINDOW_MS = 3000;
const buffer = document.getElementById("buffer") as HTMLTextAreaElement;

/** Hash of the clipboard content last seen or written by us. */
let lastHash: string | null = null;
/** Until then, the next change is treated as our own write (images get re-encoded). */
let adoptUntil = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
/** The server's max-size; bigger content is not read. */
let maxSize = Number.POSITIVE_INFINITY;
/** Serializes clipboard access. */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function toPngBase64(file: File): Promise<string> {
  if (file.type === "image/png") return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  const png = await canvas.convertToBlob({ type: "image/png" });
  return bytesToBase64(new Uint8Array(await png.arrayBuffer()));
}

/** A clipboard read. Content over the server limit is only described, never read in full. */
type ReadResult = { clip: Clip } | { tooLarge: number; signature: string } | null;

/** Reads the clipboard through a synthetic paste. */
async function readClipboard(): Promise<ReadResult> {
  let text = "";
  let files: File[] = [];
  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    // DataTransfer is only readable during the event.
    text = event.clipboardData?.getData("text/plain") ?? "";
    files = Array.from(event.clipboardData?.files ?? []);
  };
  document.addEventListener("paste", onPaste);
  try {
    buffer.value = "";
    buffer.focus();
    if (!document.execCommand("paste")) throw new Error("Clipboard read was blocked");
  } finally {
    document.removeEventListener("paste", onPaste);
  }

  // Text wins: apps like office suites put a rendered image next to copied text.
  if (text) {
    // UTF-8 never takes fewer bytes than UTF-16 code units, so this is a safe lower bound.
    if (text.length > maxSize) {
      return { tooLarge: text.length, signature: `text\0${text.length}\0${text.slice(0, 256)}\0${text.slice(-256)}` };
    }
    return { clip: { type: "text", text } };
  }
  if (files.length === 0) return null;

  const size = files.reduce((sum, f) => sum + f.size, 0);
  if (size > maxSize) {
    return { tooLarge: size, signature: `files\0${files.map((f) => `${f.name}:${f.type}:${f.size}`).join("\0")}` };
  }
  if (files.length === 1 && files[0].type.startsWith("image/")) {
    return { clip: { type: "image", base64: await toPngBase64(files[0]) } };
  }
  const entries = await Promise.all(
    files.map(async (f, i) => [f.name || `file-${i + 1}`, bytesToBase64(new Uint8Array(await f.arrayBuffer()))]),
  );
  return { clip: { type: "files", files: Object.fromEntries(entries) } };
}

/** Reads the clipboard and reports it to the service worker if it changed. */
async function check({ report }: { report: boolean }): Promise<void> {
  const result = await readClipboard();
  if (!result) return;
  const hash = "clip" in result ? await clipHash(result.clip) : result.signature;
  if (hash === lastHash) return;
  lastHash = hash;
  if (Date.now() < adoptUntil) {
    adoptUntil = 0;
    return;
  }
  if (!report) return;
  await toBackground(
    "clip" in result
      ? { type: "clipboardChanged", clip: result.clip }
      : { type: "clipboardTooLarge", size: result.tooLarge },
  );
}

async function writeText(text: string): Promise<void> {
  lastHash = await clipHash({ type: "text", text });
  buffer.value = text;
  buffer.select();
  const ok = document.execCommand("copy");
  buffer.value = "";
  if (!ok) throw new Error("Clipboard write was blocked");
}

function configure(poll: boolean, intervalMs: number, limit: number): void {
  maxSize = limit;
  clearInterval(pollTimer);
  pollTimer = poll
    ? setInterval(() => void serialized(() => check({ report: true })).catch(() => {}), Math.max(250, intervalMs))
    : undefined;
}

// ---------------------------------------------------------------- websocket

const PUBLISH_WAIT_MS = 10_000;
let socketStatus: SocketStatus = "idle";

function toBackground<T>(message: BackgroundRequest): Promise<Response<T> | undefined> {
  return chrome.runtime.sendMessage(message);
}

function reportSocket(status: SocketStatus, reason?: string): void {
  socketStatus = status;
  void toBackground({ type: "socketStatus", status, reason }).catch(() => {});
}

const connection = new Connection({
  beforeConnect: async () => {
    reportSocket("connecting");
    try {
      const res = await toBackground<boolean>({ type: "prepareConnect" });
      return res?.ok ? res.data === true : true;
    } catch {
      return true; // the service worker is restarting; just try
    }
  },
  onConnected: () => reportSocket("connected"),
  onDisconnected: (reason) => reportSocket("disconnected", reason),
  onMessage: (body) => void toBackground({ type: "socketMessage", body }).catch(() => {}),
});

/** Connects unless already connected (or connecting) to the same server. */
function connect(url: string): SocketStatus {
  if (!connection.active || connection.url !== url) {
    socketStatus = "connecting";
    connection.start(url);
  }
  return socketStatus;
}

async function publish(body: string): Promise<void> {
  if (!(await connection.waitConnected(PUBLISH_WAIT_MS))) throw new Error("Not connected to the server");
  connection.publish(body);
}

// ---------------------------------------------------------------- messages

async function handle(request: OffscreenRequest): Promise<unknown> {
  switch (request.type) {
    case "configure":
      configure(request.poll, request.intervalMs, request.maxSize);
      return;
    case "check":
      return serialized(() => check({ report: true }));
    case "read": {
      const result = await serialized(readClipboard);
      if (result && "tooLarge" in result) throw new Error(tooLargeMessage(result.tooLarge, maxSize));
      return result?.clip ?? null;
    }
    case "writeText":
      return serialized(() => writeText(request.text));
    case "expectWrite":
      lastHash = await clipHash(request.clip);
      if (request.clip.type !== "text") adoptUntil = Date.now() + ADOPT_WINDOW_MS;
      return;
    case "connect":
      return connect(request.url);
    case "disconnect":
      socketStatus = "idle";
      return connection.stop();
    case "publish":
      return publish(request.body);
    case "waitConnected":
      return connection.waitConnected(request.timeoutMs);
  }
}

chrome.runtime.onMessage.addListener((request: OffscreenRequest, _sender, sendResponse) => {
  if (request?.target !== "offscreen") return false;
  handle(request).then(
    (data) => sendResponse({ ok: true, data } satisfies Response<unknown>),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Response),
  );
  return true;
});

// Whatever is on the clipboard when we start is the baseline, not a new copy.
void serialized(() => check({ report: false })).catch(() => {});
