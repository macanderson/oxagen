// data-plane-client.test.ts — dedicated ClickHouse client cache (ADR-042 §2).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  closed: [] as unknown[],
}));

vi.mock("@clickhouse/client", () => ({
  createClient: (opts: { url: string }) => {
    mocks.createClient(opts);
    return {
      __url: opts.url,
      close: async () => {
        mocks.closed.push(opts);
      },
    };
  },
}));

import {
  closeDedicatedClickhouse,
  dedicatedClickhouse,
  dedicatedClickhouseCount,
  evictOrgClickhouse,
  MAX_DEDICATED_CLICKHOUSE_CLIENTS,
} from "./data-plane-client";

const CONFIG = {
  url: "https://ch.acme.example:8443",
  username: "acme",
  password: "s3cret",
  database: "acme_events",
};

function org(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

beforeEach(() => {
  closeDedicatedClickhouse();
  mocks.createClient.mockClear();
  mocks.closed.length = 0;
});

describe("dedicatedClickhouse", () => {
  it("creates one client per (org, digest) and reuses it", () => {
    const a = dedicatedClickhouse({ orgId: org(1), config: CONFIG, configDigest: "d" });
    const b = dedicatedClickhouse({ orgId: org(1), config: CONFIG, configDigest: "d" });
    expect(a).toBe(b);
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(dedicatedClickhouseCount()).toBe(1);
  });

  it("applies best_effort datetime parsing like the shared client", () => {
    dedicatedClickhouse({ orgId: org(1), config: CONFIG, configDigest: "d" });
    expect(mocks.createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: CONFIG.url,
        database: CONFIG.database,
        clickhouse_settings: { date_time_input_format: "best_effort" },
      }),
    );
  });

  it("rotation: a new digest replaces and closes the superseded client", () => {
    dedicatedClickhouse({ orgId: org(1), config: CONFIG, configDigest: "d1" });
    dedicatedClickhouse({
      orgId: org(1),
      config: { ...CONFIG, password: "rotated" },
      configDigest: "d2",
    });
    expect(dedicatedClickhouseCount()).toBe(1);
    expect(mocks.closed).toHaveLength(1);
  });

  it("never exceeds the LRU ceiling", () => {
    for (let i = 1; i <= MAX_DEDICATED_CLICKHOUSE_CLIENTS + 2; i++) {
      dedicatedClickhouse({ orgId: org(i), config: CONFIG, configDigest: "d" });
    }
    expect(dedicatedClickhouseCount()).toBe(MAX_DEDICATED_CLICKHOUSE_CLIENTS);
    expect(mocks.closed).toHaveLength(2);
  });

  it("a hit refreshes recency so the touched org survives eviction", () => {
    for (let i = 1; i <= MAX_DEDICATED_CLICKHOUSE_CLIENTS; i++) {
      dedicatedClickhouse({ orgId: org(i), config: CONFIG, configDigest: "d" });
    }
    const touched = dedicatedClickhouse({
      orgId: org(1),
      config: CONFIG,
      configDigest: "d",
    });
    dedicatedClickhouse({
      orgId: org(MAX_DEDICATED_CLICKHOUSE_CLIENTS + 1),
      config: CONFIG,
      configDigest: "d",
    });
    expect(
      dedicatedClickhouse({ orgId: org(1), config: CONFIG, configDigest: "d" }),
    ).toBe(touched);
  });

  it("evictOrgClickhouse closes only that organisation's client", () => {
    dedicatedClickhouse({ orgId: org(1), config: CONFIG, configDigest: "d" });
    dedicatedClickhouse({ orgId: org(2), config: CONFIG, configDigest: "d" });
    evictOrgClickhouse(org(1));
    expect(dedicatedClickhouseCount()).toBe(1);
    expect(mocks.closed).toHaveLength(1);
  });

  it("closeDedicatedClickhouse drains everything", () => {
    dedicatedClickhouse({ orgId: org(1), config: CONFIG, configDigest: "d" });
    dedicatedClickhouse({ orgId: org(2), config: CONFIG, configDigest: "d" });
    closeDedicatedClickhouse();
    expect(dedicatedClickhouseCount()).toBe(0);
    expect(mocks.closed).toHaveLength(2);
  });
});
