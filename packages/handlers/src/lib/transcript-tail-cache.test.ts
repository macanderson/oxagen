import { describe, expect, it } from "vitest";
import {
  createTailCache,
  TAIL_CACHE_LIMITS,
  type TailStart,
} from "./transcript-tail-cache";

/** A tail start holding `keys` call keys. */
function start(keys: number, seq = "40"): TailStart {
  return {
    seq,
    turn: 2,
    cost: 120,
    observed: false,
    byOpeners: true,
    keys: new Set(Array.from({ length: keys }, (_, i) => `\u0000tu_${i}`)),
  };
}

describe("createTailCache (#4340)", () => {
  it("answers a start once, to the read from the cursor that kept it", () => {
    const tails = createTailCache();
    tails.put("cursor-1", start(3));
    expect(tails.take("cursor-2")).toBeNull();
    expect(tails.take("cursor-1")?.seq).toBe("40");
    // Negative: the read took it, so a second read from that cursor reads
    // the turn's window.
    expect(tails.take("cursor-1")).toBeNull();
    expect(tails.size()).toEqual({ entries: 0, keys: 0 });
  });

  it("replaces the start kept for a cursor, and counts its keys once", () => {
    const tails = createTailCache();
    tails.put("cursor-1", start(3, "40"));
    tails.put("cursor-1", start(5, "52"));
    expect(tails.size()).toEqual({ entries: 1, keys: 5 });
    expect(tails.take("cursor-1")?.seq).toBe("52");
  });

  it("holds at most maxEntries starts, dropping the oldest", () => {
    const tails = createTailCache({ maxEntries: 2, maxKeys: 100 });
    tails.put("a", start(1));
    tails.put("b", start(1));
    tails.put("c", start(1));
    expect(tails.size()).toEqual({ entries: 2, keys: 2 });
    expect(tails.take("a")).toBeNull();
    expect(tails.take("b")).not.toBeNull();
    expect(tails.take("c")).not.toBeNull();
  });

  it("holds at most maxKeys call keys over every start, dropping the oldest", () => {
    const tails = createTailCache({ maxEntries: 10, maxKeys: 10 });
    tails.put("a", start(4));
    tails.put("b", start(4));
    expect(tails.size()).toEqual({ entries: 2, keys: 8 });
    // At the bound: one more start of four keys pushes out the oldest.
    tails.put("c", start(4));
    expect(tails.size()).toEqual({ entries: 2, keys: 8 });
    expect(tails.take("a")).toBeNull();
    // A start of exactly the bound is kept alone.
    tails.put("d", start(10));
    expect(tails.size()).toEqual({ entries: 1, keys: 10 });
    expect(tails.take("d")?.keys.size).toBe(10);
  });

  it("keeps no start with more keys than the whole bound (negative)", () => {
    const tails = createTailCache({ maxEntries: 10, maxKeys: 10 });
    tails.put("a", start(2));
    tails.put("b", start(11));
    expect(tails.take("b")).toBeNull();
    // The start already kept stays.
    expect(tails.size()).toEqual({ entries: 1, keys: 2 });
  });

  it("states its default bound: 512 starts and 32,768 call keys", () => {
    expect(TAIL_CACHE_LIMITS).toEqual({ maxEntries: 512, maxKeys: 32_768 });
    const tails = createTailCache();
    for (let i = 0; i < TAIL_CACHE_LIMITS.maxEntries + 1; i += 1)
      tails.put(`cursor-${i}`, start(64));
    // 513 starts of 64 keys would be 32,832 keys: the entry bound holds
    // first, at 512 starts and exactly the key bound.
    expect(tails.size()).toEqual({ entries: 512, keys: 32_768 });
    expect(tails.take("cursor-0")).toBeNull();
    expect(tails.take("cursor-512")).not.toBeNull();
  });
});
