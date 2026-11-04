// Tells the service worker that the user copied something in this page, so it
// can read the clipboard (the event fires before the clipboard is written).
import type { BackgroundRequest } from "../shared/messages";

function onCopy(): void {
  const message: BackgroundRequest = { type: "copyEvent" };
  try {
    // Rejects when the extension was reloaded or is not listening; nothing to do then.
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // "Extension context invalidated" after an update: this script is orphaned.
  }
}

document.addEventListener("copy", onCopy, true);
document.addEventListener("cut", onCopy, true);
