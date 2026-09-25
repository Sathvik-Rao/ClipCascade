import type { State } from "../shared/messages";
import type { Settings } from "../shared/settings";
import { callBackground, errorText, onStateChanged } from "../ui/api";

const form = document.getElementById("settings") as HTMLFormElement;
const saved = document.getElementById("saved")!;
const error = document.getElementById("error")!;
const LOCKED_WHILE_SIGNED_IN = ["serverUrl", "encryption", "hashRounds", "salt"] as const;

function input(name: keyof Settings): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement;
}

function render(state: State): void {
  for (const [name, value] of Object.entries(state.settings) as [keyof Settings, Settings[keyof Settings]][]) {
    const el = input(name);
    if (!el || el === document.activeElement) continue;
    if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = String(value);
  }
  const signedIn = state.status !== "signedOut";
  for (const name of LOCKED_WHILE_SIGNED_IN) input(name).disabled = signedIn;
  document.getElementById("lockedNote")!.hidden = !signedIn;
  input("pollIntervalMs").disabled = !state.settings.pollSystemClipboard;
}

function valueOf(el: HTMLInputElement): Settings[keyof Settings] {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "number") return Number(el.value);
  return el.value;
}

form.addEventListener("change", (event) => {
  const el = event.target as HTMLInputElement;
  if (!el.name) return;
  if (el.type === "number" && !(Number(el.value) >= Number(el.min || 0))) {
    error.textContent = `${el.name} must be at least ${el.min}`;
    return;
  }
  void callBackground<State>({ type: "updateSettings", settings: { [el.name]: valueOf(el) } }).then(
    (state) => {
      error.textContent = "";
      render(state);
      saved.textContent = "Saved";
      setTimeout(() => (saved.textContent = ""), 1200);
    },
    (e) => (error.textContent = errorText(e)),
  );
});
form.addEventListener("submit", (e) => e.preventDefault());

document.getElementById("editShortcuts")!.addEventListener("click", () => {
  void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

void chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find((c) => c.name === "send-clipboard")?.shortcut;
  if (shortcut) document.getElementById("shortcut")!.textContent = shortcut;
});

onStateChanged(render);
void callBackground<State>({ type: "getState" }).then(render, (e) => (error.textContent = errorText(e)));
