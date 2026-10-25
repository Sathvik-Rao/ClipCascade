import { base64DecodedSize, bytesToBase64 } from "./base64";

export type ClipType = "text" | "image" | "files";

export type Clip =
  | { type: "text"; text: string }
  /** Base64 image bytes, PNG when produced by this extension. */
  | { type: "image"; base64: string }
  /** File name → base64 content, the desktop client's "files" format. */
  | { type: "files"; files: Record<string, string> };

/** The `payload` string the server relays (before encryption). */
export function clipToPayload(clip: Clip): string {
  switch (clip.type) {
    case "text":
      return clip.text;
    case "image":
      return clip.base64;
    case "files":
      return JSON.stringify(clip.files);
  }
}

export function payloadToClip(payload: string, type: string | undefined): Clip {
  switch (type ?? "text") {
    case "text":
      return { type: "text", text: payload };
    case "image":
      return { type: "image", base64: payload };
    case "files": {
      const files = JSON.parse(payload) as unknown;
      if (!files || typeof files !== "object" || Array.isArray(files)) {
        throw new Error("Malformed files payload");
      }
      return { type: "files", files: files as Record<string, string> };
    }
    default:
      throw new Error(`Unsupported clip type "${type}"`);
  }
}

/** Raw content size in bytes, the quantity the desktop client checks against max-size. */
export function clipSize(clip: Clip): number {
  switch (clip.type) {
    case "text":
      return new TextEncoder().encode(clip.text).length;
    case "image":
      return base64DecodedSize(clip.base64);
    case "files":
      return Object.values(clip.files).reduce((sum, b64) => sum + base64DecodedSize(b64), 0);
  }
}

/** Stable fingerprint used to avoid re-sending content that is already synced. */
export async function clipHash(clip: Clip): Promise<string> {
  const data = new TextEncoder().encode(`${clip.type}\0${clipToPayload(clip)}`);
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export function clipSummary(clip: Clip, max = 80): string {
  switch (clip.type) {
    case "text": {
      const oneLine = clip.text.replace(/\s+/g, " ").trim();
      return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
    }
    case "image":
      return "Image";
    case "files": {
      const names = Object.keys(clip.files);
      return names.length === 1 ? names[0] : `${names.length} files`;
    }
  }
}
