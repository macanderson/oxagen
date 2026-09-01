/**
 * Token estimation: the heuristic itself and its per-message memo.
 *
 * Moved here with `estimateMessageTokens` when the TypeScript step loop that
 * used to own it was deleted; the pipeline's cost projection is what needs it
 * now.
 */
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  estimateMessageTokens,
  IMAGE_PART_TOKENS,
  FILE_PART_TOKENS,
} from "./tokens";

describe("estimateMessageTokens", () => {
  it("estimates ~chars/4 across string and structured content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "a".repeat(400) },
      {
        role: "assistant",
        content: [{ type: "text", text: "b".repeat(400) }] as never,
      },
    ];
    // ~400 + ~(json of the array) → both counted; comfortably > 100 tokens.
    expect(estimateMessageTokens(messages)).toBeGreaterThan(150);
  });

  it("returns 0 for empty content", () => {
    expect(estimateMessageTokens([{ role: "user", content: "" }])).toBe(0);
  });

  it("costs a large base64 image at the flat per-asset constant, not its length", () => {
    // A ~1 MB base64 image payload: length/4 would be ~350k tokens. It must be
    // counted flat instead, so a single screenshot never stampedes compaction.
    const bigImage = "A".repeat(1_400_000);
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this screenshot?" },
          { type: "image", image: bigImage, mediaType: "image/png" },
        ] as never,
      },
    ];
    const tokens = estimateMessageTokens(messages);
    // Near the image constant + the short text, NOT hundreds of thousands.
    expect(tokens).toBeLessThan(IMAGE_PART_TOKENS + 100);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_PART_TOKENS);
  });

  it("costs a base64 video/file part at the flat file constant", () => {
    const bigVideo = "B".repeat(3_000_000);
    const tokens = estimateMessageTokens([
      {
        role: "user",
        content: [
          { type: "file", data: bigVideo, mediaType: "video/mp4" },
        ] as never,
      },
    ]);
    expect(tokens).toBe(FILE_PART_TOKENS);
  });

  it("does NOT trigger compaction for a small conversation that carries one image", () => {
    // Reproduces the C3 defect: an otherwise-tiny turn with one image must stay
    // far below any reasonable compaction threshold (0.8 × a 200k window).
    const image = "C".repeat(2_000_000);
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "image", image, mediaType: "image/png" }] as never,
      },
      { role: "assistant", content: "Looks like a login screen." },
    ];
    expect(estimateMessageTokens(messages)).toBeLessThan(200_000 * 0.8);
  });
});

describe("estimateMessageTokens caching", () => {
  it("returns the SAME total on repeated calls (memo is exact, not stale)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "x".repeat(400) },
      { role: "assistant", content: "y".repeat(80) },
    ];
    const first = estimateMessageTokens(messages);
    const second = estimateMessageTokens(messages);
    expect(second).toBe(first);
    // ~400/4 + ~80/4 = 100 + 20.
    expect(first).toBe(Math.ceil(400 / 4) + Math.ceil(80 / 4));
  });

  it("equals the sum of the per-message estimates (cache never changes the value)", () => {
    const a: ModelMessage = { role: "user", content: "a".repeat(1000) };
    const b: ModelMessage = { role: "assistant", content: "b".repeat(200) };
    // Measure each alone (warms the cache per object), then together.
    const soloA = estimateMessageTokens([a]);
    const soloB = estimateMessageTokens([b]);
    expect(estimateMessageTokens([a, b])).toBe(soloA + soloB);
  });

  it("re-measures a NEW message object with different content (identity-keyed, self-invalidating)", () => {
    const original: ModelMessage = { role: "user", content: "z".repeat(40) };
    const before = estimateMessageTokens([original]); // 10 tokens
    // A rewrite (as compaction does) produces a NEW object → cache miss → exact.
    const rewritten: ModelMessage = { ...original, content: "z".repeat(4000) };
    const after = estimateMessageTokens([rewritten]);
    expect(before).toBe(10);
    expect(after).toBe(1000);
    // The original object's memo is untouched — still its own value.
    expect(estimateMessageTokens([original])).toBe(10);
  });
});
