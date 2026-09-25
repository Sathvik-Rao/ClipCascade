import { clipSize, clipSummary, type Clip } from "../shared/clip";
import { HISTORY_LIMIT, HISTORY_MAX_BYTES } from "../shared/constants";
import type { HistoryItem } from "../shared/messages";

type StoredItem = HistoryItem & { clip?: Clip };

// Kept in chrome.storage.session: in memory only, gone when the browser exits.
async function read(): Promise<StoredItem[]> {
  const { history } = await chrome.storage.session.get("history");
  return (history as StoredItem[] | undefined) ?? [];
}

export async function addHistory(direction: HistoryItem["direction"], clip: Clip): Promise<void> {
  const items: StoredItem[] = [
    {
      id: crypto.randomUUID(),
      direction,
      at: Date.now(),
      type: clip.type,
      summary: clipSummary(clip),
      size: clipSize(clip),
      available: true,
      clip,
    },
    ...(await read()),
  ].slice(0, HISTORY_LIMIT);

  // Keep the newest content; older entries keep only their summary.
  let budget = HISTORY_MAX_BYTES;
  for (const item of items) {
    if (!item.clip) continue;
    const cost = JSON.stringify(item.clip).length;
    if (cost > budget) {
      delete item.clip;
      item.available = false;
    } else {
      budget -= cost;
    }
  }
  await chrome.storage.session.set({ history: items });
}

/** History without clip bodies, for cheap state broadcasts. */
export async function listHistory(): Promise<HistoryItem[]> {
  return (await read()).map(({ clip: _clip, ...item }) => item);
}

export async function getHistoryClip(id: string): Promise<Clip | undefined> {
  return (await read()).find((item) => item.id === id)?.clip;
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.session.remove("history");
}
