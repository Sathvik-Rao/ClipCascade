import type { OffscreenRequest, Response } from "../shared/messages";

const OFFSCREEN_URL = "offscreen.html";
let creating: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

/** Creates the clipboard document if needed. Returns true if it was just created. */
export async function ensureOffscreen(): Promise<boolean> {
  if (await hasOffscreenDocument()) return false;
  if (creating) {
    await creating;
    return false;
  }
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Read and write the clipboard to keep it in sync with ClipCascade",
    })
    .finally(() => {
      creating = null;
    });
  await creating;
  return true;
}

export async function closeOffscreen(): Promise<void> {
  if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
}

type OffscreenMessage = OffscreenRequest extends infer M ? (M extends OffscreenRequest ? Omit<M, "target"> : never) : never;

export async function callOffscreen<T = undefined>(message: OffscreenMessage): Promise<T> {
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({ target: "offscreen", ...message })) as Response<T> | undefined;
  if (!res) throw new Error("Clipboard document did not respond");
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
}
