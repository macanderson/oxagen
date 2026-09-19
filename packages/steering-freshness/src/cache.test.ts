import { describe, expect, it, vi } from "vitest";
import {
  readFetchStamp,
  shouldFetch,
  stampPath,
  writeFetchStamp,
  type CacheIo,
} from "./cache";

const DIR = "/repo/.git";

describe("stampPath", () => {
  // The cache must never land under `.oxagen/`: that directory's cleanliness
  // is what decides whether a sync is allowed to run.
  it("keeps the stamp out of .oxagen", () => {
    expect(stampPath(DIR)).toBe("/repo/.git/oxagen/steering-freshness.json");
    expect(stampPath(DIR)).not.toContain(".oxagen");
  });
});

function io(
  files: Record<string, string>,
): CacheIo & { files: Record<string, string> } {
  return {
    files,
    read: (async (p: unknown) => {
      const key = String(p);
      if (!(key in files)) throw new Error("ENOENT");
      return files[key]!;
    }) as unknown as CacheIo["read"],
    write: (async (p: unknown, data: unknown) => {
      files[String(p)] = String(data);
    }) as unknown as CacheIo["write"],
    mkdirp: async () => undefined,
  };
}

describe("readFetchStamp", () => {
  it("returns null when there is no stamp", async () => {
    expect(await readFetchStamp(DIR, io({}))).toBeNull();
  });

  it("returns null on a corrupt stamp rather than throwing", async () => {
    const files = { [stampPath(DIR)]: "not json" };
    expect(await readFetchStamp(DIR, io(files))).toBeNull();
  });

  it("returns null when the stamp is missing its fields", async () => {
    const files = { [stampPath(DIR)]: JSON.stringify({ ok: true }) };
    expect(await readFetchStamp(DIR, io(files))).toBeNull();
  });

  it("round-trips a stamp", async () => {
    const store = io({});
    await writeFetchStamp(
      DIR,
      { attemptedAt: 5, target: "origin/main", ok: true },
      store,
    );
    expect(await readFetchStamp(DIR, store)).toEqual({
      attemptedAt: 5,
      target: "origin/main",
      ok: true,
    });
  });

  it("swallows a write it cannot do, because the cost is only a fetch", async () => {
    const failing: CacheIo = {
      read: (async () => {
        throw new Error("nope");
      }) as unknown as CacheIo["read"],
      write: vi.fn(async () => {
        throw new Error("read-only");
      }) as unknown as CacheIo["write"],
      mkdirp: async () => undefined,
    };
    await expect(
      writeFetchStamp(DIR, { attemptedAt: 1, target: "t", ok: true }, failing),
    ).resolves.toBeUndefined();
  });
});

describe("shouldFetch", () => {
  const stamp = { attemptedAt: 1_000_000, target: "origin/main", ok: true };

  it("fetches when there is no stamp", () => {
    expect(shouldFetch(null, "origin/main", 300, 1_000_000)).toBe(true);
  });

  it("fetches every time at interval 0", () => {
    expect(shouldFetch(stamp, "origin/main", 0, 1_000_000)).toBe(true);
  });

  it("suppresses a fetch inside the interval", () => {
    expect(shouldFetch(stamp, "origin/main", 300, 1_000_000 + 299_000)).toBe(
      false,
    );
  });

  it("fetches once the interval has passed", () => {
    expect(shouldFetch(stamp, "origin/main", 300, 1_000_000 + 300_000)).toBe(
      true,
    );
  });

  it("does not let one branch's stamp suppress another branch's fetch", () => {
    expect(shouldFetch(stamp, "origin/release", 300, 1_000_000 + 1)).toBe(true);
  });

  // A laptop waking, or a corrected clock, must not lock the throttle shut.
  it("fetches when the clock has moved backwards", () => {
    expect(shouldFetch(stamp, "origin/main", 300, 999_000)).toBe(true);
  });
});
