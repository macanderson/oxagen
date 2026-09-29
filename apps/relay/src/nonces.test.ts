// nonces.test.ts: NonceCache, the envelope nonces the relay has accepted and when it may forget each one.
import { describe, expect, it } from "vitest";
import { DEFAULT_NONCE_CAPACITY, NonceCache } from "./nonces";
import { NOW } from "./test/fixtures";

/** When a nonce claimed at NOW may be forgotten, as for an envelope with a ten-second life. */
const FORGET_AT = NOW + 10_000;

describe("NonceCache", () => {
  it("starts empty", () => {
    expect(new NonceCache(4).size).toBe(0);
  });

  it("accepts a new nonce, then answers replayed for it while it is live", () => {
    const cache = new NonceCache(4);

    expect(cache.claim("n-1", FORGET_AT, NOW)).toBe("accepted");
    expect(cache.claim("n-1", FORGET_AT, NOW + 1)).toBe("replayed");
    expect(cache.claim("n-1", FORGET_AT, FORGET_AT - 1)).toBe("replayed");
    expect(cache.size).toBe(1);
  });

  it("forgets a nonce at its forgetAt time and accepts it again with the new time", () => {
    const cache = new NonceCache(4);
    cache.claim("n-1", FORGET_AT, NOW);

    expect(cache.claim("n-1", FORGET_AT + 10_000, FORGET_AT)).toBe("accepted");
    expect(cache.size).toBe(1);
    // The second claim recorded the later time, so the nonce is live again.
    expect(cache.claim("n-1", FORGET_AT + 10_000, FORGET_AT + 1)).toBe("replayed");
  });

  it("answers full when every entry is live, and does not record the nonce", () => {
    const cache = new NonceCache(2);
    cache.claim("n-1", FORGET_AT, NOW);
    cache.claim("n-2", FORGET_AT, NOW);

    expect(cache.claim("n-3", FORGET_AT, NOW)).toBe("full");
    expect(cache.size).toBe(2);
    // n-3 was never recorded, so once there is room it is new, not a replay.
    expect(cache.claim("n-3", FORGET_AT + 10_000, FORGET_AT)).toBe("accepted");
  });

  it("answers replayed, not full, for a live nonce when the cache is full", () => {
    const cache = new NonceCache(2);
    cache.claim("n-1", FORGET_AT, NOW);
    cache.claim("n-2", FORGET_AT, NOW);

    expect(cache.claim("n-1", FORGET_AT, NOW + 1)).toBe("replayed");
  });

  it("drops expired entries to make room for a new nonce", () => {
    const cache = new NonceCache(2);
    cache.claim("n-1", NOW + 100, NOW);
    cache.claim("n-2", FORGET_AT, NOW);

    expect(cache.claim("n-3", FORGET_AT, NOW + 100)).toBe("accepted");
    expect(cache.size).toBe(2);
  });

  it("frees room when the nonce claimed again is itself expired", () => {
    const cache = new NonceCache(1);
    cache.claim("n-1", NOW + 100, NOW);

    expect(cache.claim("n-1", FORGET_AT, NOW + 100)).toBe("accepted");
    expect(cache.size).toBe(1);
  });

  it("drops an expired entry that sits behind a live one before answering full", () => {
    // n-2 expires before n-1, so the purge from the front stops at n-1. The
    // cache is full, so it sweeps every entry and finds n-2 expired.
    const cache = new NonceCache(2);
    cache.claim("n-1", FORGET_AT, NOW);
    cache.claim("n-2", NOW + 100, NOW);

    expect(cache.claim("n-3", FORGET_AT, NOW + 200)).toBe("accepted");
    expect(cache.size).toBe(2);
    expect(cache.claim("n-1", FORGET_AT, NOW + 200)).toBe("replayed");
    expect(cache.claim("n-4", FORGET_AT, NOW + 200)).toBe("full");
  });

  it("holds DEFAULT_NONCE_CAPACITY nonces when built without a capacity", () => {
    const cache = new NonceCache();
    for (let index = 0; index < DEFAULT_NONCE_CAPACITY; index += 1) cache.claim(`n-${index}`, FORGET_AT, NOW);

    expect(cache.size).toBe(DEFAULT_NONCE_CAPACITY);
    expect(cache.claim("one-more", FORGET_AT, NOW)).toBe("full");
  });
});
