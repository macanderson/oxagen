/**
 * client.test.ts
 *
 * Unit tests for the lazy Drizzle singleton in client.ts.
 *
 * Dependencies are mocked so no live DB or env is needed:
 *   - postgres       → controlled fake pool with a spy `.end()` method
 *   - drizzle-orm/postgres-js → returns a stable mock DB object
 *   - @oxagen/config/env → requireEnv returns configurable env values
 *
 * Because client.ts holds module-level singletons (_client / _db),
 * `vi.resetModules()` is called in beforeEach so each test receives
 * a fresh module instance with null singletons.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The first dynamic import of ./client cold-compiles the full ./schema barrel
// (4k+ lines), which can exceed the 5s default timeout on a cold CI cache and
// flake the first lazy-import test. Raise the per-file timeout to match the
// repo's established lazy-import pattern.
vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// Hoisted mock factories — created ONCE, referenced by vi.mock() closures.
// vi.hoisted() runs before module evaluation so the variables are available
// inside the factory callbacks.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const endFn = vi.fn().mockResolvedValue(undefined);
  const fakePool = { end: endFn };
  const postgresFn = vi.fn().mockReturnValue(fakePool);

  const fakeDrizzleDb = { _brand: "drizzle-db" as const };
  const drizzleFn = vi.fn().mockReturnValue(fakeDrizzleDb);

  const requireEnvFn = vi.fn();

  return {
    endFn,
    fakePool,
    postgresFn,
    fakeDrizzleDb,
    drizzleFn,
    requireEnvFn,
  };
});

vi.mock("postgres", () => ({ default: mocks.postgresFn }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzleFn }));
vi.mock("@oxagen/config/env", () => ({ requireEnv: mocks.requireEnvFn }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_ENV = {
  DATABASE_URL: "postgres://localhost:5433/test",
  NODE_ENV: "development",
};
const PROD_ENV = {
  DATABASE_URL: "postgres://prod.example.com/db",
  NODE_ENV: "production",
};

// ---------------------------------------------------------------------------
// db() — lazy singleton
// ---------------------------------------------------------------------------

describe("db()", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Reset default return values after clearAllMocks
    mocks.postgresFn.mockReturnValue(mocks.fakePool);
    mocks.drizzleFn.mockReturnValue(mocks.fakeDrizzleDb);
    mocks.endFn.mockResolvedValue(undefined);
  });

  it("returns the drizzle db instance on first call", async () => {
    mocks.requireEnvFn.mockReturnValue(DEV_ENV);
    const { db } = await import("./client");

    const result = db();

    expect(result).toBe(mocks.fakeDrizzleDb);
  });

  it("memoizes — second call returns the same instance without re-initialising", async () => {
    mocks.requireEnvFn.mockReturnValue(DEV_ENV);
    const { db } = await import("./client");

    const first = db();
    const second = db();

    expect(first).toBe(second);
    // postgres and drizzle should only be constructed once
    expect(mocks.postgresFn).toHaveBeenCalledTimes(1);
    expect(mocks.drizzleFn).toHaveBeenCalledTimes(1);
  });

  it("passes max:5 to postgres in development mode", async () => {
    mocks.requireEnvFn.mockReturnValue(DEV_ENV);
    const { db } = await import("./client");

    db();

    expect(mocks.postgresFn).toHaveBeenCalledWith(DEV_ENV.DATABASE_URL, {
      max: 5,
      prepare: false,
    });
  });

  it("passes max:20 to postgres in production mode", async () => {
    mocks.requireEnvFn.mockReturnValue(PROD_ENV);
    const { db } = await import("./client");

    db();

    expect(mocks.postgresFn).toHaveBeenCalledWith(PROD_ENV.DATABASE_URL, {
      max: 20,
      prepare: false,
    });
  });

  it("calls requireEnv with DATABASE_URL and NODE_ENV keys", async () => {
    mocks.requireEnvFn.mockReturnValue(DEV_ENV);
    const { db } = await import("./client");

    db();

    expect(mocks.requireEnvFn).toHaveBeenCalledWith([
      "DATABASE_URL",
      "NODE_ENV",
    ]);
  });
});

// ---------------------------------------------------------------------------
// closeDatabase()
// ---------------------------------------------------------------------------

describe("closeDatabase()", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.postgresFn.mockReturnValue(mocks.fakePool);
    mocks.drizzleFn.mockReturnValue(mocks.fakeDrizzleDb);
    mocks.endFn.mockResolvedValue(undefined);
  });

  it("ends the pool and resets the singleton when a pool exists", async () => {
    mocks.requireEnvFn.mockReturnValue(DEV_ENV);
    const { db, closeDatabase } = await import("./client");

    // Initialise the singleton
    db();
    expect(mocks.postgresFn).toHaveBeenCalledTimes(1);

    await closeDatabase();

    expect(mocks.endFn).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("re-initialises after close (singleton is reset)", async () => {
    mocks.requireEnvFn.mockReturnValue(DEV_ENV);
    const { db, closeDatabase } = await import("./client");

    db();
    await closeDatabase();

    // After close, calling db() must create a new pool
    db();
    expect(mocks.postgresFn).toHaveBeenCalledTimes(2);
  });

  it("is a no-op and resolves when the pool was never initialised", async () => {
    const { closeDatabase } = await import("./client");

    await expect(closeDatabase()).resolves.toBeUndefined();
    // end() must NOT be called — no pool exists
    expect(mocks.endFn).not.toHaveBeenCalled();
  });
});
