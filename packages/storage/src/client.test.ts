// client.test.ts
//
// Unit tests for storage() singleton from @oxagen/storage/client.
//
// Strategy:
//  - Mock requireEnv and createVercelBlobAdapter to avoid real network.
//  - Use vi.resetModules() + dynamic import to reset the singleton between tests.
//  - Assert: missing token throws, valid token creates adapter, memoized ref,
//    driver selection via STORAGE_DRIVER env var.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock factories — defined once, controlled per-test via return values.
// ---------------------------------------------------------------------------

const requireEnvMock = vi.hoisted(() =>
  vi.fn(
    (_keys: readonly string[]): Record<string, string | undefined> => ({
      STORAGE_DRIVER: "vercel-blob",
      BLOB_READ_WRITE_TOKEN: undefined,
    }),
  ),
);

const createVercelBlobAdapterMock = vi.hoisted(() =>
  vi.fn((_token: string) => ({ driver: "vercel-blob" as const })),
);

const createFsAdapterMock = vi.hoisted(() =>
  vi.fn((_root: string | undefined) => ({ driver: "fs" as const })),
);

vi.mock("@oxagen/config/env", () => ({
  requireEnv: requireEnvMock,
}));

vi.mock("./vercel-blob", () => ({
  createVercelBlobAdapter: createVercelBlobAdapterMock,
}));

vi.mock("./fs-driver", () => ({
  createFsAdapter: createFsAdapterMock,
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
  createFsAdapterMock.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Missing token — throws with BLOB_READ_WRITE_TOKEN in the message
// ---------------------------------------------------------------------------

describe("storage() — missing token", () => {
  it("throws when BLOB_READ_WRITE_TOKEN is undefined", async () => {
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER"))
        return { STORAGE_DRIVER: "vercel-blob" };
      return { BLOB_READ_WRITE_TOKEN: undefined };
    });
    const { storage } = await freshStorage();
    expect(() => storage()).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });

  it("throws when BLOB_READ_WRITE_TOKEN is an empty string", async () => {
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER"))
        return { STORAGE_DRIVER: "vercel-blob" };
      return { BLOB_READ_WRITE_TOKEN: "" };
    });
    const { storage } = await freshStorage();
    expect(() => storage()).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// Valid token — returns adapter with driver: "vercel-blob"
// ---------------------------------------------------------------------------

describe("storage() — valid token", () => {
  beforeEach(() => {
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER"))
        return { STORAGE_DRIVER: "vercel-blob" };
      return { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_testStore_someSecret" };
    });
  });

  it("calls createVercelBlobAdapter with the token", async () => {
    const { storage } = await freshStorage();
    storage();
    expect(createVercelBlobAdapterMock).toHaveBeenCalledWith(
      "vercel_blob_rw_testStore_someSecret",
    );
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
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER"))
        return { STORAGE_DRIVER: "vercel-blob" };
      return { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_testStore_secret" };
    });
    const { storage } = await freshStorage();
    const a = storage();
    const b = storage();
    expect(a).toBe(b);
  });

  it("createVercelBlobAdapter is called exactly once for multiple storage() calls", async () => {
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER"))
        return { STORAGE_DRIVER: "vercel-blob" };
      return { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_testStore_secret" };
    });
    const { storage } = await freshStorage();
    storage();
    storage();
    storage();
    expect(createVercelBlobAdapterMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Driver selection — STORAGE_DRIVER env var
// ---------------------------------------------------------------------------

describe("storage() — driver selection", () => {
  it("defaults to vercel-blob when STORAGE_DRIVER is not explicitly set", async () => {
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER")) return { STORAGE_DRIVER: undefined };
      return { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_testStore_secret" };
    });
    const { storage } = await freshStorage();
    const adapter = storage();
    expect(adapter.driver).toBe("vercel-blob");
    expect(createVercelBlobAdapterMock).toHaveBeenCalledWith(
      "vercel_blob_rw_testStore_secret",
    );
  });

  it("resolves to vercel-blob when STORAGE_DRIVER is explicitly 'vercel-blob'", async () => {
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER"))
        return { STORAGE_DRIVER: "vercel-blob" };
      return { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_testStore_explicit" };
    });
    const { storage } = await freshStorage();
    const adapter = storage();
    expect(adapter.driver).toBe("vercel-blob");
    expect(createVercelBlobAdapterMock).toHaveBeenCalledWith(
      "vercel_blob_rw_testStore_explicit",
    );
  });

  it("throws a clear error listing supported drivers for an unknown STORAGE_DRIVER", async () => {
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER")) return { STORAGE_DRIVER: "s3" };
      return { BLOB_READ_WRITE_TOKEN: "some-token" };
    });
    const { storage } = await freshStorage();
    expect(() => storage()).toThrow(/Unknown STORAGE_DRIVER: "s3"/);
    expect(() => storage()).toThrow(/vercel-blob/);
    // The error must enumerate the fs driver too.
    expect(() => storage()).toThrow(/fs/);
  });
});

// ---------------------------------------------------------------------------
// fs driver — resolves WITHOUT a Vercel Blob token
// ---------------------------------------------------------------------------

describe("storage() — fs driver", () => {
  it("resolves the fs adapter without BLOB_READ_WRITE_TOKEN present", async () => {
    // storage() must not require a Vercel Blob token on the fs path. requireEnv
    // only ever returns STORAGE_DRIVER + STORAGE_FS_ROOT here — no blob token.
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER")) return { STORAGE_DRIVER: "fs" };
      if (keys.includes("STORAGE_FS_ROOT"))
        return { STORAGE_FS_ROOT: "/tmp/oxagen-storage" };
      return {};
    });
    const { storage } = await freshStorage();
    expect(() => storage()).not.toThrow();
    const adapter = storage();
    expect(adapter.driver).toBe("fs");
    expect(createFsAdapterMock).toHaveBeenCalledWith("/tmp/oxagen-storage");
    // The vercel-blob adapter must never be constructed on the fs path.
    expect(createVercelBlobAdapterMock).not.toHaveBeenCalled();
  });

  it("passes an undefined root through to the fs adapter (driver defaults it)", async () => {
    requireEnvMock.mockImplementation((keys: readonly string[]) => {
      if (keys.includes("STORAGE_DRIVER")) return { STORAGE_DRIVER: "fs" };
      if (keys.includes("STORAGE_FS_ROOT"))
        return { STORAGE_FS_ROOT: undefined };
      return {};
    });
    const { storage } = await freshStorage();
    const adapter = storage();
    expect(adapter.driver).toBe("fs");
    expect(createFsAdapterMock).toHaveBeenCalledWith(undefined);
  });
});
