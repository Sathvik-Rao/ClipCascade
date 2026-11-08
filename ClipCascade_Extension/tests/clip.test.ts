import { describe, expect, it } from "vitest";
import { clipHash, clipSize, clipSummary, clipToPayload, payloadToClip, type Clip } from "../src/shared/clip";

describe("clip payloads", () => {
  const clips: Clip[] = [
    { type: "text", text: "héllo" },
    { type: "image", base64: "iVBORw0KGgo=" },
    { type: "files", files: { "a.txt": "aGk=", "b.bin": "AAEC" } },
  ];

  it.each(clips)("round-trips $type", (clip) => {
    expect(payloadToClip(clipToPayload(clip), clip.type)).toEqual(clip);
  });

  it("uses the desktop files format: a JSON object of name to base64", () => {
    expect(JSON.parse(clipToPayload(clips[2]))).toEqual({ "a.txt": "aGk=", "b.bin": "AAEC" });
  });

  it("defaults a missing type to text, like the server", () => {
    expect(payloadToClip("x", undefined)).toEqual({ type: "text", text: "x" });
  });

  it("rejects unknown types and malformed files", () => {
    expect(() => payloadToClip("x", "video")).toThrow();
    expect(() => payloadToClip("[1]", "files")).toThrow();
  });

  it("measures raw content bytes", () => {
    expect(clipSize(clips[0])).toBe(6);
    expect(clipSize(clips[1])).toBe(8);
    expect(clipSize(clips[2])).toBe(5);
  });

  it("hashes by type and content", async () => {
    expect(await clipHash({ type: "text", text: "a" })).toBe(await clipHash({ type: "text", text: "a" }));
    expect(await clipHash({ type: "text", text: "a" })).not.toBe(await clipHash({ type: "image", base64: "a" }));
  });

  it("summarizes", () => {
    expect(clipSummary({ type: "text", text: "  a\n\n b  " })).toBe("a b");
    expect(clipSummary({ type: "text", text: "x".repeat(100) }, 10)).toBe("xxxxxxxxx…");
    expect(clipSummary(clips[2])).toBe("2 files");
  });
});
