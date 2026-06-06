// client.test.ts
//
// Unit tests for storage() singleton from @oxagen/storage/client.
//
// Strategy:
//  - Mock requireEnv and createVercelBlobAdapter to avoid real network.
//  - Use vi.resetModules() + dynamic import to reset the singleton between tests.
//  - Assert: missing token throws, valid token creates adapter, memoized ref.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock factories — defined once, controlled per-test via return values.
// ---------------------------------------------------------------------------

const requireEnvMock = vi.hoisted(() =>
  vi.fn((_keys: readonly string[]): { BLOB_READ_WRITE_TOKEN: string | undefined } => ({
    BLOB_READ_WRITE_TOKEN: undefined,
  })),
);

const createVercelBlobAdapterMock = vi.hoisted(() =>
  vi.fn((_token: string) => ({ driver: "vercel-blob" as const })),
);

vi.mock("@oxagen/config/env", () => ({
  requireEnv: requireEnvMock,
}));

vi.mock("./vercel-blob", () => ({
  createVercelBlobAdapter: createVercelBlobAdapterMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fresh import of the client module (bypasses singleton via resetModules). */
async function freshStorage() {
  vi.resetModules();
  const mod = await import("./client");
  return mod;
}

beforeEach(() => {
  requireEnvMock.mockClear();
  createVercelBlobAdapterMock.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Missing token → throws with BLOB_READ_WRITE_TOKEN in the message
// ---------------------------------------------------------------------------

describe("storage() — missing token", () => {
  it("throws when BLOB_READ_WRITE_TOKEN is undefined", async () => {
    requireEnvMock.mockReturnValue({ BLOB_READ_WRITE_TOKEN: undefined });
    const { storage } = await freshStorage();
    expect(() => storage()).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });

  it("throws when BLOB_READ_WRITE_TOKEN is an empty string", async () => {
    // requireEnv returns empty string — the guard `if (!BLOB_READ_WRITE_TOKEN)` is truthy for ""
    requireEnvMock.mockReturnValue({ BLOB_READ_WRITE_TOKEN: "" });
    const { storage } = await freshStorage();
    expect(() => storage()).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// Valid token → returns adapter with driver: "vercel-blob"
// ---------------------------------------------------------------------------

describe("storage() — valid token", () => {
  beforeEach(() => {
    requireEnvMock.mockReturnValue({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_testStore_someSecret" });
  });

  it("calls createVercelBlobAdapter with the token", async () => {
    const { storage } = await freshStorage();
    storage();
    expect(createVercelBlobAdapterMock).toHaveBeenCalledWith("vercel_blob_rw_testStore_someSecret");
  });

  it("returned adapter has driver: 'vercel-blob'", async () => {
    const { storage } = await freshStorage();
    const adapter = storage();
    expect(adapter.driver).toBe("vercel-blob");
  });
});

// ---------------------------------------------------------------------------
// Memoization — two calls return the same reference (singleton)
// ---------------------------------------------------------------------------

describe("storage() — singleton memoization", () => {
  it("two calls return the exact same adapter reference", async () => {
    requireEnvMock.mockReturnValue({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_testStore_secret" });
    const { storage } = await freshStorage();
    const a = storage();
    const b = storage();
    expect(a).toBe(b);
  });

  it("createVercelBlobAdapter is called exactly once for multiple storage() calls", async () => {
    requireEnvMock.mockReturnValue({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_testStore_secret" });
    const { storage } = await freshStorage();
    storage();
    storage();
    storage();
    expect(createVercelBlobAdapterMock).toHaveBeenCalledTimes(1);
  });
});
