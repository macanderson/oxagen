// data-plane-resolver.test.ts — the platform half of the ADR-042 seam.
//
// Invariants:
//   1. No row  → the SHARED plane (absence of a binding IS the default).
//   2. A dedicated row round-trips through the real @oxagen/crypto envelope —
//      the resolver decrypts what set_data_plane encrypted, and the ciphertext
//      never resembles the plaintext.
//   3. degraded / disabled statuses survive to the binding so the store
//      clients can fail closed; an unrecognised status degrades to `disabled`.
//   4. The read is cached for a short TTL and dropped by invalidation.
//   5. A dedicated row with no envelope, or with no KEK configured, THROWS —
//      it never falls back to the shared plane.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), evictOrg: vi.fn() }));

vi.mock("./tenant", () => ({
  withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ query: { dataPlanes: { findFirst: mocks.findFirst } } }),
}));
vi.mock("./data-plane-pool", () => ({ evictOrg: mocks.evictOrg }));

import {
  bootstrapDataPlaneResolver,
  clearDataPlaneCache,
  DATA_PLANE_KEY_ID,
  invalidateDataPlaneCache,
  loadDataPlaneBinding,
  parsePlaneConfig,
  platformDataPlaneResolver,
  resolveDataPlaneKms,
} from "./data-plane-resolver";
import {
  clearDataPlaneResolver,
  hasDataPlaneResolver,
  resolveDataPlane,
} from "@oxagen/tenancy";

const ORG = "00000000-0000-0000-0000-00000000a111";
// A deterministic 256-bit KEK. Test-only material; never a real key.
const MASTER_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

const PG_CONFIG = {
  host: "pg.acme.example",
  port: 6543,
  database: "acme",
  username: "acme_app",
  password: "rotate-me",
  ssl: true,
};

async function envelopeFor(config: unknown): Promise<Buffer> {
  const adapter = createLocalKmsAdapter(Buffer.from(MASTER_KEY_B64, "base64"));
  return encrypt(JSON.stringify(config), DATA_PLANE_KEY_ID, { adapter });
}

beforeEach(() => {
  mocks.findFirst.mockReset();
  mocks.evictOrg.mockReset();
  clearDataPlaneCache();
  process.env.AUTH_TOKEN_ENCRYPTION_KEY = MASTER_KEY_B64;
});

afterEach(() => {
  clearDataPlaneResolver();
  delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
});

describe("loadDataPlaneBinding", () => {
  it("returns the shared plane when the organisation has no row", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(loadDataPlaneBinding(ORG, "postgres")).resolves.toEqual({
      orgId: ORG,
      kind: "postgres",
      mode: "shared",
      status: "active",
      configDigest: null,
      schemaVersion: null,
    });
  });

  it("returns a shared row without touching the envelope", async () => {
    mocks.findFirst.mockResolvedValue({
      mode: "shared",
      status: "active",
      configCiphertext: null,
      configKeyId: null,
      configDigest: null,
      schemaVersion: null,
    });
    const binding = await loadDataPlaneBinding(ORG, "clickhouse");
    expect(binding.mode).toBe("shared");
    expect(binding.config).toBeUndefined();
  });

  it("decrypts a dedicated Postgres binding end to end", async () => {
    const ciphertext = await envelopeFor(PG_CONFIG);
    // The envelope must not contain the plaintext password anywhere.
    expect(ciphertext.toString("utf8")).not.toContain("rotate-me");
    mocks.findFirst.mockResolvedValue({
      mode: "dedicated",
      status: "active",
      configCiphertext: ciphertext,
      configKeyId: DATA_PLANE_KEY_ID,
      configDigest: "digest-1",
      schemaVersion: "20260907130000",
    });
    const binding = await loadDataPlaneBinding(ORG, "postgres");
    expect(binding).toMatchObject({
      mode: "dedicated",
      status: "active",
      configDigest: "digest-1",
      schemaVersion: "20260907130000",
    });
    expect(binding.config).toEqual({
      host: "pg.acme.example",
      port: 6543,
      database: "acme",
      username: "acme_app",
      password: "rotate-me",
      ssl: true,
      maxConnections: undefined,
    });
  });

  it("carries degraded/disabled status through so callers fail closed", async () => {
    mocks.findFirst.mockResolvedValue({
      mode: "shared",
      status: "degraded",
      configCiphertext: null,
      configKeyId: null,
    });
    await expect(loadDataPlaneBinding(ORG, "neo4j")).resolves.toMatchObject({
      status: "degraded",
    });
  });

  it("treats an unrecognised status as disabled (fail closed)", async () => {
    mocks.findFirst.mockResolvedValue({
      mode: "shared",
      status: "who-knows",
      configCiphertext: null,
      configKeyId: null,
    });
    await expect(loadDataPlaneBinding(ORG, "neo4j")).resolves.toMatchObject({
      status: "disabled",
    });
  });

  it("throws — never falls back — when a dedicated row has no envelope", async () => {
    mocks.findFirst.mockResolvedValue({
      mode: "dedicated",
      status: "active",
      configCiphertext: null,
      configKeyId: null,
    });
    await expect(loadDataPlaneBinding(ORG, "postgres")).rejects.toThrow(
      /refusing to fall back to the shared plane/,
    );
  });

  it("throws when the KEK is unconfigured", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    mocks.findFirst.mockResolvedValue({
      mode: "dedicated",
      status: "active",
      configCiphertext: Buffer.from([1, 2, 3]),
      configKeyId: DATA_PLANE_KEY_ID,
    });
    await expect(loadDataPlaneBinding(ORG, "postgres")).rejects.toThrow(
      /AUTH_TOKEN_ENCRYPTION_KEY is unset/,
    );
  });
});

describe("platformDataPlaneResolver caching", () => {
  it("reads Postgres once per (org, kind) within the TTL", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await platformDataPlaneResolver(ORG, "postgres");
    await platformDataPlaneResolver(ORG, "postgres");
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  });

  it("caches per store kind, not per organisation alone", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await platformDataPlaneResolver(ORG, "postgres");
    await platformDataPlaneResolver(ORG, "neo4j");
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed read", async () => {
    mocks.findFirst.mockRejectedValueOnce(new Error("pg down"));
    await expect(platformDataPlaneResolver(ORG, "postgres")).rejects.toThrow(
      "pg down",
    );
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(platformDataPlaneResolver(ORG, "postgres")).resolves.toMatchObject(
      { mode: "shared" },
    );
  });

  it("invalidation forces a re-read and evicts the org's Postgres pool", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await platformDataPlaneResolver(ORG, "postgres");
    invalidateDataPlaneCache(ORG);
    await platformDataPlaneResolver(ORG, "postgres");
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
    expect(mocks.evictOrg).toHaveBeenCalledWith(
      ORG,
      "data-plane binding changed",
    );
  });

  it("kind-scoped invalidation drops only that kind and skips the pool for non-postgres", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await platformDataPlaneResolver(ORG, "postgres");
    await platformDataPlaneResolver(ORG, "neo4j");
    invalidateDataPlaneCache(ORG, "neo4j");
    expect(mocks.evictOrg).not.toHaveBeenCalled();
    await platformDataPlaneResolver(ORG, "postgres"); // still cached
    await platformDataPlaneResolver(ORG, "neo4j"); // re-read
    expect(mocks.findFirst).toHaveBeenCalledTimes(3);
  });
});

describe("bootstrapDataPlaneResolver", () => {
  it("wires the platform resolver into the tenancy seam", async () => {
    expect(hasDataPlaneResolver()).toBe(false);
    bootstrapDataPlaneResolver();
    expect(hasDataPlaneResolver()).toBe(true);
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(resolveDataPlane(ORG, "postgres")).resolves.toMatchObject({
      mode: "shared",
    });
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  });

  it("is idempotent", () => {
    bootstrapDataPlaneResolver();
    bootstrapDataPlaneResolver();
    expect(hasDataPlaneResolver()).toBe(true);
  });
});

describe("parsePlaneConfig", () => {
  it("parses a neo4j config", () => {
    expect(
      parsePlaneConfig("neo4j", {
        uri: "neo4j+s://graph.acme.example",
        username: "neo4j",
        password: "p",
        database: "acme",
      }),
    ).toEqual({
      uri: "neo4j+s://graph.acme.example",
      username: "neo4j",
      password: "p",
      database: "acme",
    });
  });

  it("parses a clickhouse config", () => {
    expect(
      parsePlaneConfig("clickhouse", {
        url: "https://ch.acme.example:8443",
        username: "default",
        password: "p",
        database: "acme",
      }),
    ).toMatchObject({ url: "https://ch.acme.example:8443", database: "acme" });
  });

  it("defaults the Postgres port and ssl", () => {
    const cfg = parsePlaneConfig("postgres", {
      host: "h",
      database: "d",
      username: "u",
      password: "p",
    }) as { port: number; ssl?: boolean };
    expect(cfg.port).toBe(5432);
    expect(cfg.ssl).toBe(true);
  });

  it("rejects a config missing a required field", () => {
    expect(() => parsePlaneConfig("neo4j", { uri: "x" })).toThrow(
      /missing the "username" field/,
    );
  });

  it("rejects a null payload rather than producing an empty config", () => {
    expect(() => parsePlaneConfig("clickhouse", null)).toThrow(/missing the/);
  });
});

describe("resolveDataPlaneKms", () => {
  it("returns null when the KEK env var is unset", () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    expect(resolveDataPlaneKms()).toBeNull();
  });

  it("returns the versioned key id when configured", () => {
    expect(resolveDataPlaneKms()?.keyId).toBe(DATA_PLANE_KEY_ID);
  });
});
