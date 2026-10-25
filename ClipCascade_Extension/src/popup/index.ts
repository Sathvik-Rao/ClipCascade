import { base64ToBytes } from "../shared/base64";
import type { Clip } from "../shared/clip";
import { formatBytes } from "../shared/format";
import type { HistoryItem, State } from "../shared/messages";
import type { Settings } from "../shared/settings";
import { callBackground, errorText, onStateChanged } from "../ui/api";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const loginForm = $<HTMLFormElement>("login");
const main = $("main");
const statusPill = $("status");
const historyList = $<HTMLUListElement>("history");
const composeText = $<HTMLTextAreaElement>("composeText");
const composeStatus = $("composeStatus");

const STATUS_LABEL: Record<State["status"], string> = {
  signedOut: "Signed out",
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Offline",
};

let renderedHistoryKey = "";

function render(state: State): void {
  statusPill.textContent = STATUS_LABEL[state.status];
  statusPill.className = `pill ${state.status}`;
  const signedIn = state.status !== "signedOut";
  loginForm.hidden = signedIn;
  main.hidden = !signedIn;
  for (const el of document.querySelectorAll<HTMLElement>("[data-error]")) el.textContent = state.error ?? "";

  if (!signedIn) {
    fillLoginForm(state.settings);
    return;
  }
  $("account").textContent = `${state.username} · ${state.serverUrl ? new URL(state.serverUrl).host : ""}`;
  $("reconnect").hidden = state.status !== "disconnected";
  $<HTMLInputElement>("captureBrowserCopies").checked = state.settings.captureBrowserCopies;
  $<HTMLInputElement>("pollSystemClipboard").checked = state.settings.pollSystemClipboard;

  // Rebuild the list only when it changed, so thumbnails don't flicker.
  const key = state.history.map((h) => h.id + h.available).join();
  if (key !== renderedHistoryKey) {
    renderedHistoryKey = key;
    historyList.replaceChildren(...state.history.map(renderHistoryItem));
  }
  $("historyEmpty").hidden = state.history.length > 0;
}

let loginFormFilled = false;
function fillLoginForm(settings: Settings): void {
  if (loginFormFilled) return;
  loginFormFilled = true;
  const f = loginForm.elements;
  (f.namedItem("serverUrl") as HTMLInputElement).value = settings.serverUrl;
  (f.namedItem("username") as HTMLInputElement).value = settings.username;
  (f.namedItem("rememberMe") as HTMLInputElement).checked = settings.rememberMe;
  (f.namedItem("encryption") as HTMLInputElement).checked = settings.encryption;
  (f.namedItem("hashRounds") as HTMLInputElement).value = String(settings.hashRounds);
  (f.namedItem("salt") as HTMLInputElement).value = settings.salt;
  const focus = settings.serverUrl ? (settings.username ? "password" : "username") : "serverUrl";
  (f.namedItem(focus) as HTMLInputElement).focus();
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderHistoryItem(item: HistoryItem): HTMLLIElement {
  const li = document.createElement("li");

  const dir = document.createElement("span");
  dir.className = `dir ${item.direction}`;
  dir.textContent = item.direction === "in" ? "↓" : "↑";
  dir.title = item.direction === "in" ? "Received" : "Sent";
  li.append(dir);

  if (item.type === "image" && item.available) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    void getClip(item.id).then((clip) => {
      if (clip?.type === "image") img.src = `data:image/png;base64,${clip.base64}`;
    });
    li.append(img);
  }

  const text = document.createElement("div");
  text.className = "grow";
  const summary = document.createElement("div");
  summary.className = "summary";
  summary.textContent = item.summary || "(empty)";
  summary.title = item.summary;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${formatTime(item.at)} · ${formatBytes(item.size)}${item.available ? "" : " · no longer stored"}`;
  text.append(summary, meta);
  li.append(text);

  if (item.available) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.type === "files" ? "Save" : "Copy";
    button.addEventListener("click", () => {
      void (item.type === "files" ? saveFiles(item.id) : copyItem(item.id)).then(
        () => flash(button, item.type === "files" ? "Saved" : "Copied"),
        (e) => flash(button, "Failed", errorText(e)),
      );
    });
    li.append(button);
  }
  return li;
}

function flash(button: HTMLButtonElement, label: string, title = ""): void {
  const original = button.textContent;
  button.textContent = label;
  button.title = title;
  setTimeout(() => (button.textContent = original), 1500);
}

async function getClip(id: string): Promise<Clip> {
  const clip = await callBackground<Clip | undefined>({ type: "getHistoryClip", id });
  if (!clip) throw new Error("This item is no longer stored");
  return clip;
}

async function toPngBlob(base64: string): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([base64ToBytes(base64)]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function copyItem(id: string): Promise<void> {
  const clip = await getClip(id);
  // Tell the background first, so the clipboard watcher doesn't send it straight back.
  await callBackground({ type: "expectWrite", clip });
  if (clip.type === "text") {
    await navigator.clipboard.writeText(clip.text);
  } else if (clip.type === "image") {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": toPngBlob(clip.base64) })]);
  }
}

async function saveFiles(id: string): Promise<void> {
  const clip = await getClip(id);
  if (clip.type !== "files") return;
  for (const [name, base64] of Object.entries(clip.files)) {
    await chrome.downloads.download({
      url: `data:application/octet-stream;base64,${base64}`,
      filename: name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "file",
      saveAs: false,
    });
  }
}

async function run(action: () => Promise<unknown>, button?: HTMLButtonElement, busyLabel?: string): Promise<void> {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
  }
  try {
    await action();
  } catch (e) {
    for (const el of document.querySelectorAll<HTMLElement>("[data-error]")) el.textContent = errorText(e);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label ?? "";
    }
  }
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(loginForm);
  const button = loginForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
  void run(
    async () => {
      const settings: Partial<Settings> = {
        rememberMe: data.get("rememberMe") === "on",
        encryption: data.get("encryption") === "on",
        hashRounds: Number(data.get("hashRounds")) || undefined,
        salt: String(data.get("salt") ?? ""),
      };
      if (!settings.hashRounds) delete settings.hashRounds;
      render(
        await callBackground<State>({
          type: "login",
          serverUrl: String(data.get("serverUrl")),
          username: String(data.get("username")).trim(),
          password: String(data.get("password")),
          settings,
        }),
      );
    },
    button,
    "Signing in…",
  );
});

$("signOut").addEventListener("click", () => {
  loginFormFilled = false;
  void run(async () => render(await callBackground<State>({ type: "logout" })));
});

$("reconnect").addEventListener("click", (e) => {
  void run(async () => render(await callBackground<State>({ type: "reconnect" })), e.currentTarget as HTMLButtonElement);
});

for (const id of ["captureBrowserCopies", "pollSystemClipboard"] as const) {
  $<HTMLInputElement>(id).addEventListener("change", (e) => {
    const checked = (e.currentTarget as HTMLInputElement).checked;
    void run(async () => render(await callBackground<State>({ type: "updateSettings", settings: { [id]: checked } })));
  });
}

$<HTMLFormElement>("compose").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = composeText.value;
  if (!text) return;
  const button = (event.currentTarget as HTMLFormElement).querySelector<HTMLButtonElement>("button[type=submit]")!;
  void run(
    async () => {
      await callBackground({ type: "sendClip", clip: { type: "text", text } });
      composeText.value = "";
      composeStatus.textContent = "Sent";
      setTimeout(() => (composeStatus.textContent = ""), 1500);
    },
    button,
  );
});

composeText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) $<HTMLFormElement>("compose").requestSubmit();
});

$("sendClipboard").addEventListener("click", (e) => {
  void run(
    async () => {
      await callBackground({ type: "sendClipboardNow" });
      composeStatus.textContent = "Sent";
      setTimeout(() => (composeStatus.textContent = ""), 1500);
    },
    e.currentTarget as HTMLButtonElement,
  );
});

$("clearHistory").addEventListener("click", () => void run(() => callBackground({ type: "clearHistory" })));
$("openOptions").addEventListener("click", () => void chrome.runtime.openOptionsPage());

onStateChanged(render);
void callBackground<State>({ type: "getState" }).then(render, (e) => {
  statusPill.textContent = errorText(e);
});
