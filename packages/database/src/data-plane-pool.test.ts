// data-plane-pool.test.ts — dedicated-plane Postgres pooling (ADR-042 §2).
//
// Invariants:
//   1. One pool per (organisation, config digest) — repeat calls reuse it.
//   2. A NEW digest for the same organisation opens a new pool and CLOSES the
//      one bound to the superseded credential (rotation).
//   3. Two organisations never share a pool.
//   4. The cache is LRU-bounded: exceeding MAX_DEDICATED_POOLS evicts and
//      closes the least-recently-used entry, and a hit re-orders it.
//   5. TLS is on by default for a customer-controlled endpoint.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postgres: vi.fn(),
  drizzle: vi.fn(),
  ends: [] as Array<{ opts: unknown }>,
}));

vi.mock("postgres", () => ({
  default: (opts: unknown) => {
    mocks.postgres(opts);
    return {
      __opts: opts,
      end: vi.fn(async () => {
        mocks.ends.push({ opts });
      }),
    };
  },
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (client: unknown) => {
    mocks.drizzle(client);
    return { __client: client } as never;
  },
}));

import {
  closeDedicatedPools,
  dedicatedDb,
  dedicatedPoolCount,
  evictOrg,
  MAX_DEDICATED_POOLS,
} from "./data-plane-pool";

const CONFIG = {
  host: "pg.acme.example",
  port: 5432,
  database: "acme",
  username: "acme_app",
  password: "s3cret",
};

function org(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

beforeEach(() => {
  closeDedicatedPools();
  mocks.postgres.mockClear();
  mocks.drizzle.mockClear();
  mocks.ends.length = 0;
});

describe("dedicatedDb", () => {
  it("opens one pool and reuses it for the same org + digest", () => {
    const a = dedicatedDb({
      orgId: org(1),
      config: CONFIG,
      configDigest: "d1",
    });
    const b = dedicatedDb({
      orgId: org(1),
      config: CONFIG,
      configDigest: "d1",
    });
    expect(a).toBe(b);
    expect(mocks.postgres).toHaveBeenCalledTimes(1);
    expect(dedicatedPoolCount()).toBe(1);
  });

  it("passes host/port/database/credentials through and defaults ssl on", () => {
    dedicatedDb({ orgId: org(1), config: CONFIG, configDigest: "d1" });
    expect(mocks.postgres).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "pg.acme.example",
        port: 5432,
        database: "acme",
        username: "acme_app",
        password: "s3cret",
        ssl: true,
        prepare: false,
      }),
    );
  });

  it("honours an explicit ssl:false and a custom connection ceiling", () => {
    dedicatedDb({
      orgId: org(1),
      config: { ...CONFIG, ssl: false, maxConnections: 3 },
      configDigest: "d1",
    });
    expect(mocks.postgres).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: false, max: 3 }),
    );
  });

  it("rotation: a new digest opens a new pool and closes the superseded one", () => {
    dedicatedDb({ orgId: org(1), config: CONFIG, configDigest: "d1" });
    dedicatedDb({
      orgId: org(1),
      config: { ...CONFIG, password: "rotated" },
      configDigest: "d2",
    });
    expect(mocks.postgres).toHaveBeenCalledTimes(2);
    // Exactly one live pool for the org — the old one was evicted, not kept.
    expect(dedicatedPoolCount()).toBe(1);
    expect(mocks.ends).toHaveLength(1);
  });

  it("keeps organisations on separate pools", () => {
    const a = dedicatedDb({ orgId: org(1), config: CONFIG, configDigest: "d" });
    const b = dedicatedDb({ orgId: org(2), config: CONFIG, configDigest: "d" });
    expect(a).not.toBe(b);
    expect(dedicatedPoolCount()).toBe(2);
  });

  it("keys per organisation even when the digest is missing", () => {
    dedicatedDb({ orgId: org(1), config: CONFIG });
    dedicatedDb({ orgId: org(2), config: CONFIG });
    expect(dedicatedPoolCount()).toBe(2);
    expect(mocks.postgres).toHaveBeenCalledTimes(2);
  });
});

describe("LRU eviction", () => {
  it("never exceeds MAX_DEDICATED_POOLS and closes the evicted pool", () => {
    for (let i = 1; i <= MAX_DEDICATED_POOLS + 3; i++) {
      dedicatedDb({ orgId: org(i), config: CONFIG, configDigest: "d" });
    }
    expect(dedicatedPoolCount()).toBe(MAX_DEDICATED_POOLS);
    expect(mocks.ends).toHaveLength(3);
  });

  it("a hit refreshes recency so the touched org survives eviction", () => {
    for (let i = 1; i <= MAX_DEDICATED_POOLS; i++) {
      dedicatedDb({ orgId: org(i), config: CONFIG, configDigest: "d" });
    }
    // Touch the oldest so it is no longer the eviction candidate.
    const touched = dedicatedDb({
      orgId: org(1),
      config: CONFIG,
      configDigest: "d",
    });
    // Force one eviction — org(2) is now the least-recently-used.
    dedicatedDb({
      orgId: org(MAX_DEDICATED_POOLS + 1),
      config: CONFIG,
      configDigest: "d",
    });
    expect(dedicatedPoolCount()).toBe(MAX_DEDICATED_POOLS);
    // org(1) still resolves to the SAME handle: it was not reopened.
    const openedBefore = mocks.postgres.mock.calls.length;
    expect(
      dedicatedDb({ orgId: org(1), config: CONFIG, configDigest: "d" }),
    ).toBe(touched);
    expect(mocks.postgres.mock.calls.length).toBe(openedBefore);
  });
});

describe("explicit eviction", () => {
  it("evictOrg closes every pool for one organisation only", () => {
    dedicatedDb({ orgId: org(1), config: CONFIG, configDigest: "d" });
    dedicatedDb({ orgId: org(2), config: CONFIG, configDigest: "d" });
    evictOrg(org(1));
    expect(dedicatedPoolCount()).toBe(1);
    expect(mocks.ends).toHaveLength(1);
  });

  it("evictOrg on an unknown organisation is a no-op", () => {
    dedicatedDb({ orgId: org(1), config: CONFIG, configDigest: "d" });
    evictOrg(org(9));
    expect(dedicatedPoolCount()).toBe(1);
    expect(mocks.ends).toHaveLength(0);
  });

  it("closeDedicatedPools drains everything", () => {
    dedicatedDb({ orgId: org(1), config: CONFIG, configDigest: "d" });
    dedicatedDb({ orgId: org(2), config: CONFIG, configDigest: "d" });
    closeDedicatedPools();
    expect(dedicatedPoolCount()).toBe(0);
    expect(mocks.ends).toHaveLength(2);
  });
});
