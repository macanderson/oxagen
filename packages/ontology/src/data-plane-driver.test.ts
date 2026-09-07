// data-plane-driver.test.ts — dedicated Neo4j driver cache (ADR-042 §2).
//
// Same contract as the Postgres pool cache: one driver per (organisation,
// config digest), rotation closes the superseded driver, and the cache is
// LRU-bounded so a control plane never holds one live driver per organisation.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  driverFactory: vi.fn(),
  sessionFactory: vi.fn(),
  closed: [] as string[],
}));

vi.mock("neo4j-driver", () => ({
  default: {
    driver: (uri: string, auth: unknown) => {
      mocks.driverFactory(uri, auth);
      return {
        session: (opts: unknown) => {
          mocks.sessionFactory(opts);
          return { run: vi.fn(), close: vi.fn() };
        },
        close: async () => {
          mocks.closed.push(uri);
        },
      };
    },
    auth: { basic: (u: string, p: string) => ({ u, p }) },
  },
}));

import {
  closeDedicatedDrivers,
  dedicatedDriverCount,
  dedicatedSession,
  evictOrgDrivers,
  MAX_DEDICATED_DRIVERS,
} from "./data-plane-driver";

const CONFIG = {
  uri: "neo4j+s://graph.acme.example",
  username: "neo4j",
  password: "s3cret",
  database: "acme",
};

function org(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

beforeEach(() => {
  closeDedicatedDrivers();
  mocks.driverFactory.mockClear();
  mocks.sessionFactory.mockClear();
  mocks.closed.length = 0;
});

describe("dedicatedSession", () => {
  it("creates one driver per (org, digest) and reuses it across sessions", () => {
    dedicatedSession({ orgId: org(1), config: CONFIG, configDigest: "d1" });
    dedicatedSession({ orgId: org(1), config: CONFIG, configDigest: "d1" });
    expect(mocks.driverFactory).toHaveBeenCalledTimes(1);
    expect(mocks.sessionFactory).toHaveBeenCalledTimes(2);
    expect(dedicatedDriverCount()).toBe(1);
  });

  it("binds the session to the plane's database", () => {
    dedicatedSession({ orgId: org(1), config: CONFIG, configDigest: "d1" });
    expect(mocks.sessionFactory).toHaveBeenCalledWith({ database: "acme" });
    expect(mocks.driverFactory).toHaveBeenCalledWith(
      "neo4j+s://graph.acme.example",
      { u: "neo4j", p: "s3cret" },
    );
  });

  it("rotation: a new digest replaces and closes the superseded driver", () => {
    dedicatedSession({ orgId: org(1), config: CONFIG, configDigest: "d1" });
    dedicatedSession({
      orgId: org(1),
      config: { ...CONFIG, password: "rotated" },
      configDigest: "d2",
    });
    expect(mocks.driverFactory).toHaveBeenCalledTimes(2);
    expect(dedicatedDriverCount()).toBe(1);
    expect(mocks.closed).toHaveLength(1);
  });

  it("never exceeds MAX_DEDICATED_DRIVERS", () => {
    for (let i = 1; i <= MAX_DEDICATED_DRIVERS + 2; i++) {
      dedicatedSession({ orgId: org(i), config: CONFIG, configDigest: "d" });
    }
    expect(dedicatedDriverCount()).toBe(MAX_DEDICATED_DRIVERS);
    expect(mocks.closed).toHaveLength(2);
  });

  it("a hit refreshes recency so the touched org survives eviction", () => {
    for (let i = 1; i <= MAX_DEDICATED_DRIVERS; i++) {
      dedicatedSession({ orgId: org(i), config: CONFIG, configDigest: "d" });
    }
    dedicatedSession({ orgId: org(1), config: CONFIG, configDigest: "d" });
    dedicatedSession({
      orgId: org(MAX_DEDICATED_DRIVERS + 1),
      config: CONFIG,
      configDigest: "d",
    });
    const before = mocks.driverFactory.mock.calls.length;
    dedicatedSession({ orgId: org(1), config: CONFIG, configDigest: "d" });
    expect(mocks.driverFactory.mock.calls.length).toBe(before);
  });
});

describe("eviction", () => {
  it("evictOrgDrivers closes only that organisation's driver", () => {
    dedicatedSession({ orgId: org(1), config: CONFIG, configDigest: "d" });
    dedicatedSession({ orgId: org(2), config: CONFIG, configDigest: "d" });
    evictOrgDrivers(org(1));
    expect(dedicatedDriverCount()).toBe(1);
    expect(mocks.closed).toHaveLength(1);
  });

  it("closeDedicatedDrivers drains everything", () => {
    dedicatedSession({ orgId: org(1), config: CONFIG, configDigest: "d" });
    dedicatedSession({ orgId: org(2), config: CONFIG, configDigest: "d" });
    closeDedicatedDrivers();
    expect(dedicatedDriverCount()).toBe(0);
    expect(mocks.closed).toHaveLength(2);
  });
});
