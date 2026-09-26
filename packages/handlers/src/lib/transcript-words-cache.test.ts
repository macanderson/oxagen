import { type RunFrame, tachoFrame, wordsDigest } from "@oxagen/run-ledger";
import { describe, expect, it } from "vitest";
import { tachoRow } from "../run.test-support";
import { createWordsCache, UNREADABLE } from "./transcript-words-cache";

const A = { orgId: "org-a", workspaceId: "ws-a" };
const B = { orgId: "org-b", workspaceId: "ws-a" };

/** A frame whose kept body is named by `n`. */
function frame(n: number, over: Record<string, unknown> = {}): RunFrame {
  return tachoFrame(
    tachoRow(n, {
      kind: "turn_start",
      contentDigest: `sha256:${String(n).padStart(64, "0")}`,
      bytesRef: `evb:v1:k:${String(n).padStart(64, "0")}`,
      ...over,
    }),
  );
}

const said = (text: string) => ({
  stream: false as const,
  words: wordsDigest(text),
});

describe("createWordsCache", () => {
  it("answers what was kept for the same tenant and body", () => {
    const cache = createWordsCache();
    cache.set(A, frame(1), said("Ship it."));
    expect(cache.get(A, frame(1))).toEqual(said("Ship it."));
    expect(cache.get(A, frame(2))).toBeUndefined();
  });

  it("keeps the digest of the words and never the words (negative)", () => {
    const cache = createWordsCache();
    cache.set(A, frame(1), said("The deploy key is hunter2."));
    const kept = JSON.stringify(cache.get(A, frame(1)));
    expect(kept).not.toContain("hunter2");
    expect(kept).toMatch(/sha256:[0-9a-f]{64}/);
  });

  it("never answers one tenant's read from another tenant's body (negative)", () => {
    const cache = createWordsCache();
    cache.set(A, frame(1), said("Ship it."));
    expect(cache.get(B, frame(1))).toBeUndefined();
    expect(
      cache.get({ orgId: "org-a", workspaceId: "ws-b" }, frame(1)),
    ).toBeUndefined();
  });

  it("keys on the digest the frame recorded as well as the reference (negative)", () => {
    const cache = createWordsCache();
    cache.set(A, frame(1), said("Ship it."));
    const other = frame(1, { contentDigest: `sha256:${"9".repeat(64)}` });
    expect(cache.get(A, other)).toBeUndefined();
  });

  it("keeps nothing for a frame with no kept body (negative)", () => {
    const cache = createWordsCache();
    const bare = frame(1, { bytesRef: "", contentDigest: "" });
    cache.set(A, bare, said("words"));
    cache.fail(A, bare);
    expect(cache.get(A, bare)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("evicts the least recently used body at its entry bound", () => {
    const cache = createWordsCache({ maxEntries: 2, failureTtlMs: 1_000 });
    cache.set(A, frame(1), said("one"));
    cache.set(A, frame(2), said("two"));
    // Reading the first makes the second the least recently used.
    cache.get(A, frame(1));
    cache.set(A, frame(3), said("three"));
    expect(cache.get(A, frame(1))).toEqual(said("one"));
    expect(cache.get(A, frame(2))).toBeUndefined();
    expect(cache.get(A, frame(3))).toEqual(said("three"));
    expect(cache.size()).toBe(2);
  });

  it("remembers a body that could not be read as unreadable, not as showing no words, until its TTL passes", () => {
    let at = 0;
    const cache = createWordsCache(
      { maxEntries: 10, failureTtlMs: 1_000 },
      () => at,
    );
    cache.fail(A, frame(1));
    at = 999;
    expect(cache.get(A, frame(1))).toBe(UNREADABLE);
    at = 1_000;
    expect(cache.get(A, frame(1))).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("keeps what a body said with no expiry, and replaces a body kept twice", () => {
    let at = 0;
    const cache = createWordsCache(
      { maxEntries: 10, failureTtlMs: 1_000 },
      () => at,
    );
    cache.fail(A, frame(1));
    cache.set(A, frame(1), { stream: true, last: wordsDigest("Shipped.") });
    cache.set(A, frame(1), { stream: true, last: null });
    at = 1_000_000;
    expect(cache.get(A, frame(1))).toEqual({ stream: true, last: null });
    expect(cache.size()).toBe(1);
  });
});
