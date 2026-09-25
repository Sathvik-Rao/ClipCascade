import type { BackgroundRequest, Broadcast, Response, State } from "../shared/messages";

export async function callBackground<T = undefined>(request: BackgroundRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
  if (!res) throw new Error("The extension did not respond");
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
}

export function onStateChanged(listener: (state: State) => void): void {
  chrome.runtime.onMessage.addListener((message: Broadcast | { type?: string }) => {
    if (message?.type === "stateChanged") listener((message as Broadcast).state);
    return false;
  });
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
