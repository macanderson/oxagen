import { type RunFrame, tachoFrame } from "@oxagen/run-ledger";
import { describe, expect, it } from "vitest";
import { tachoRow } from "../run.test-support";
import { createWordsCache } from "./transcript-words-cache";

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

const text = (words: string) => ({ stream: false as const, text: words });

describe("createWordsCache", () => {
  it("answers what was kept for the same tenant and body", () => {
    const cache = createWordsCache();
    cache.set(A, frame(1), text("Ship it."));
    expect(cache.get(A, frame(1))).toEqual(text("Ship it."));
    expect(cache.get(A, frame(2))).toBeUndefined();
  });

  it("never answers one tenant's read from another tenant's body (negative)", () => {
    const cache = createWordsCache();
    cache.set(A, frame(1), text("Ship it."));
    expect(cache.get(B, frame(1))).toBeUndefined();
    expect(
      cache.get({ orgId: "org-a", workspaceId: "ws-b" }, frame(1)),
    ).toBeUndefined();
  });

  it("keys on the digest the frame recorded as well as the reference (negative)", () => {
    const cache = createWordsCache();
    cache.set(A, frame(1), text("Ship it."));
    const other = frame(1, { contentDigest: `sha256:${"9".repeat(64)}` });
    expect(cache.get(A, other)).toBeUndefined();
  });

  it("keeps nothing for a frame with no kept body (negative)", () => {
    const cache = createWordsCache();
    const bare = frame(1, { bytesRef: "", contentDigest: "" });
    cache.set(A, bare, text("words"));
    expect(cache.get(A, bare)).toBeUndefined();
    expect(cache.size().entries).toBe(0);
  });

  it("evicts the least recently used body at its entry bound", () => {
    const cache = createWordsCache({
      maxEntries: 2,
      maxChars: 1_000_000,
      maxValueChars: 1_000,
    });
    cache.set(A, frame(1), text("one"));
    cache.set(A, frame(2), text("two"));
    // Reading the first makes the second the least recently used.
    cache.get(A, frame(1));
    cache.set(A, frame(3), text("three"));
    expect(cache.get(A, frame(1))).toEqual(text("one"));
    expect(cache.get(A, frame(2))).toBeUndefined();
    expect(cache.get(A, frame(3))).toEqual(text("three"));
    expect(cache.size().entries).toBe(2);
  });

  it("stays within its character bound, and keeps no body larger than one value may be", () => {
    const key = `${A.orgId}\n${A.workspaceId}\nevb:v1:k:${"0".repeat(64)}\nsha256:${"0".repeat(64)}`;
    const cache = createWordsCache({
      maxEntries: 100,
      maxChars: 2 * (key.length + 10),
      maxValueChars: 10,
    });
    cache.set(A, frame(1), text("x".repeat(10)));
    cache.set(A, frame(2), text("y".repeat(10)));
    cache.set(A, frame(3), text("z".repeat(10)));
    expect(cache.get(A, frame(1))).toBeUndefined();
    expect(cache.size()).toEqual({ entries: 2, chars: 2 * (key.length + 10) });

    cache.set(A, frame(4), text("w".repeat(11)));
    expect(cache.get(A, frame(4))).toBeUndefined();
    expect(cache.size().entries).toBe(2);
  });

  it("counts a stream's last text block, and replaces a body kept twice", () => {
    const cache = createWordsCache();
    cache.set(A, frame(1), { stream: true, last: "Shipped." });
    cache.set(A, frame(1), { stream: true, last: null });
    expect(cache.get(A, frame(1))).toEqual({ stream: true, last: null });
    expect(cache.size().entries).toBe(1);
  });
});
