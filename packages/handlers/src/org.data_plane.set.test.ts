import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  invalidate: vi.fn(),
  resolveKms: vi.fn(),
  emit: vi.fn(),
  encrypt: vi.fn(),
}));

/** Minimal Drizzle chain doubles: .update().set().where().returning() etc. */
function makeTx() {
  return {
    query: { dataPlanes: { findFirst: mocks.findFirst } },
    update: () => ({
      set: (values: unknown) => ({
        where: () => ({
          returning: async () => {
            mocks.update(values);
            return [{ ...(values as object), id: "row-1" }];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: unknown) => ({
        returning: async () => {
          mocks.insert(values);
          return [{ ...(values as object), id: "row-1" }];
        },
      }),
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  };
});
vi.mock("@oxagen/database/data-plane", () => ({
  invalidateDataPlaneCache: mocks.invalidate,
  resolveDataPlaneKms: mocks.resolveKms,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emit,
}));
vi.mock("@oxagen/crypto", () => ({
  encrypt: async (plaintext: string, keyId: string) => {
    mocks.encrypt(plaintext, keyId);
    return Buffer.from(`enc(${plaintext.length})`);
  },
}));

import { configDigest, orgDataPlaneSetHandler } from "./org.data_plane.set";
import { orgDataPlaneSet } from "@oxagen/oxagen/contracts/org.data_plane.set";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const PG_CONFIG = {
  host: "pg.acme.example",
  port: 6543,
  database: "acme",
  username: "acme_app",
  password: "super-secret",
  ssl: true,
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.resolveKms.mockReturnValue({
    adapter: {},
    keyId: "data_plane_v1",
  });
});

describe("configDigest", () => {
  it("is stable regardless of key order", () => {
    expect(configDigest({ a: 1, b: 2 })).toBe(configDigest({ b: 2, a: 1 }));
  });

  it("changes when a credential rotates (so the pool key misses)", () => {
    expect(configDigest(PG_CONFIG)).not.toBe(
      configDigest({ ...PG_CONFIG, password: "rotated" }),
    );
  });

  it("is a hex sha-256, never the plaintext", () => {
    const d = configDigest(PG_CONFIG);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).not.toContain("super-secret");
  });
});

describe("org.data_plane.set handler — dedicated", () => {
  const input = {
    kind: "postgres" as const,
    mode: "dedicated" as const,
    config: PG_CONFIG,
  };

  it("envelope-encrypts the config before any write", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgDataPlaneSetHandler(input, CTX);
    expect(mocks.encrypt).toHaveBeenCalledWith(
      JSON.stringify(PG_CONFIG),
      "data_plane_v1",
    );
    const written = mocks.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.configCiphertext).toBeInstanceOf(Buffer);
    expect(written.configKeyId).toBe("data_plane_v1");
    expect(written.configDigest).toBe(configDigest(PG_CONFIG));
    // No plaintext credential anywhere in the persisted row.
    expect(JSON.stringify(written)).not.toContain("super-secret");
  });

  it("REFUSES to store a plaintext config when the KEK is unconfigured", async () => {
    mocks.resolveKms.mockReturnValue(null);
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(orgDataPlaneSetHandler(input, CTX)).rejects.toThrow(
      /Refusing to store it in plaintext/,
    );
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("resets verification/schema metadata and stamps rotatedAt", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgDataPlaneSetHandler(input, CTX);
    const written = mocks.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.status).toBe("active");
    expect(written.schemaVersion).toBeNull();
    expect(written.lastVerifiedAt).toBeNull();
    expect(written.rotatedAt).toBeInstanceOf(Date);
    expect(written.orgId).toBe(CTX.orgId);
    expect(written.kind).toBe("postgres");
  });

  it("updates the existing binding instead of inserting a second one", async () => {
    mocks.findFirst.mockResolvedValue({ id: "row-1", mode: "shared" });
    await orgDataPlaneSetHandler(input, CTX);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("invalidates the resolver cache for exactly this org + kind", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgDataPlaneSetHandler(input, CTX);
    expect(mocks.invalidate).toHaveBeenCalledWith(CTX.orgId, "postgres");
  });

  it("emits a data_plane.updated security event with no config in it", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgDataPlaneSetHandler(input, CTX);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    const event = mocks.emit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.eventType).toBe("data_plane.updated");
    expect(event.capability).toBe("set_data_plane");
    expect(event.outcome).toBe("success");
    expect(event.orgId).toBe(CTX.orgId);
    expect(event.actorUserId).toBe(CTX.userId);
    expect(event.workspaceId).toBeNull();
    expect(JSON.stringify(event)).not.toContain("super-secret");
  });

  it("returns the REDACTED binding the contract declares", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const out = await orgDataPlaneSetHandler(input, CTX);
    expect(() => orgDataPlaneSet.output.parse(out)).not.toThrow();
    expect(out).toMatchObject({
      kind: "postgres",
      mode: "dedicated",
      status: "active",
      host: "pg.acme.example",
      database: "acme",
    });
    expect(JSON.stringify(out)).not.toContain("super-secret");
    expect(JSON.stringify(out)).not.toContain("acme_app");
  });
});

describe("org.data_plane.set handler — back to shared", () => {
  const input = { kind: "neo4j" as const, mode: "shared" as const };

  it("clears the envelope columns and never calls the KMS", async () => {
    mocks.findFirst.mockResolvedValue({ id: "row-1", mode: "dedicated" });
    await orgDataPlaneSetHandler(input, CTX);
    expect(mocks.encrypt).not.toHaveBeenCalled();
    const written = mocks.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.configCiphertext).toBeNull();
    expect(written.configKeyId).toBeNull();
    expect(written.configDigest).toBeNull();
    expect(written.rotatedAt).toBeNull();
    expect(written.mode).toBe("shared");
  });

  it("succeeds even without a KEK — unbinding stores no secret", async () => {
    mocks.resolveKms.mockReturnValue(null);
    mocks.findFirst.mockResolvedValue({ id: "row-1", mode: "dedicated" });
    const out = await orgDataPlaneSetHandler(input, CTX);
    expect(out.mode).toBe("shared");
    expect(out.host).toBeNull();
    expect(out.database).toBeNull();
  });

  it("still evicts the cache and audits the change", async () => {
    mocks.findFirst.mockResolvedValue({ id: "row-1", mode: "dedicated" });
    await orgDataPlaneSetHandler(input, CTX);
    expect(mocks.invalidate).toHaveBeenCalledWith(CTX.orgId, "neo4j");
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });
});
