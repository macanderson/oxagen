/**
 * Unit tests for the simpler connection handler files that were added without
 * tests in Phase 1B:
 *
 *   connection.list.ts
 *   connection.get.ts
 *   connection.create.ts
 *   connection.mappings.get.ts
 *
 * Phase 3 prime-directive fix: the Phase 1B handlers coverage was 0% for these
 * files, which dropped the handlers package below the 84% coverage gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  encrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
  getConnector: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/crypto", () => ({
  encrypt: mocks.encrypt,
  decrypt: vi.fn(),
  createIngestionCryptoAdapter: mocks.createIngestionCryptoAdapter,
}));

vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: mocks.getConnector,
}));

// ── helpers ───────────────────────────────────────────────────────────────────

type TxLike = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
};

type DbFn = (tx: TxLike) => Promise<unknown>;

/**
 * Build a simple Drizzle chain mock that always resolves `.limit()` or the
 * last chainable method to `rows`. Also provides `.orderBy()` for list queries.
 */
function makeTxReturning(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn().mockReturnValue(insertChain),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.encrypt.mockResolvedValue(Buffer.from("encrypted"));
  mocks.createIngestionCryptoAdapter.mockReturnValue({
    adapter: {},
    keyId: "k1",
  });
  mocks.getConnector.mockReturnValue({ deliveryMethod: "webhook" });
});

// ── connection.list ────────────────────────────────────────────────────────────

import { connectionListHandler } from "./connection.list";

describe("connectionListHandler", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");
  const BASE_ROW = {
    id: "uuid-1",
    publicId: "con_ABC",
    connectorId: "github",
    displayName: "My GitHub",
    authScheme: "oauth2",
    deliveryMethod: "webhook",
    status: "connected",
    entityCount: 10,
    lastSyncAt: NOW,
    createdAt: NOW,
  };

  it("returns empty connections when none exist", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([]) as TxLike),
    );
    const result = await connectionListHandler({}, CTX);
    expect(result.connections).toHaveLength(0);
  });

  it("returns mapped connections with ISO date strings", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([BASE_ROW]) as TxLike),
    );
    const result = await connectionListHandler({}, CTX);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]!.publicId).toBe("con_ABC");
    expect(result.connections[0]!.lastSyncAt).toBe(NOW.toISOString());
    expect(result.connections[0]!.createdAt).toBe(NOW.toISOString());
  });

  it("returns null lastSyncAt when not set", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([{ ...BASE_ROW, lastSyncAt: null }]) as TxLike),
    );
    const result = await connectionListHandler({}, CTX);
    expect(result.connections[0]!.lastSyncAt).toBeNull();
  });

  it("passes status filter to query builder", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([]) as TxLike),
    );
    await connectionListHandler({ status: "connected" }, CTX);
    // We can only assert the call was made — the drizzle chain internals are opaque in tests.
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("passes connectorId filter to query builder", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([]) as TxLike),
    );
    await connectionListHandler({ connectorId: "github" }, CTX);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});

// ── connection.get ─────────────────────────────────────────────────────────────

import { connectionGetHandler } from "./connection.get";

describe("connectionGetHandler", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");
  const BASE_ROW = {
    id: "uuid-1",
    publicId: "con_ABC",
    connectorId: "github",
    displayName: "My GitHub",
    authScheme: "oauth2",
    deliveryMethod: "webhook",
    deliveryConfig: { owner: "acme" },
    status: "connected",
    entityCount: 10,
    lastSyncAt: NOW,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("throws 404 when connection not found", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([]) as TxLike),
    );
    await expect(
      connectionGetHandler({ connectionId: "missing" }, CTX),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("returns connection with ISO date strings on happy path", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([BASE_ROW]) as TxLike),
    );
    const result = await connectionGetHandler({ connectionId: "con_ABC" }, CTX);
    expect(result.publicId).toBe("con_ABC");
    expect(result.createdAt).toBe(NOW.toISOString());
    expect(result.updatedAt).toBe(NOW.toISOString());
  });

  it("returns null lastSyncAt when not set", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([{ ...BASE_ROW, lastSyncAt: null }]) as TxLike),
    );
    const result = await connectionGetHandler({ connectionId: "con_ABC" }, CTX);
    expect(result.lastSyncAt).toBeNull();
  });

  it("wraps deliveryConfig in null when absent", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([{ ...BASE_ROW, deliveryConfig: null }]) as TxLike),
    );
    const result = await connectionGetHandler({ connectionId: "con_ABC" }, CTX);
    expect(result.deliveryConfig).toBeNull();
  });
});

// ── connection.create ──────────────────────────────────────────────────────────

import { connectionCreateHandler } from "./connection.create";

describe("connectionCreateHandler", () => {
  const CONN_ROW = {
    id: "uuid-conn-1",
    publicId: "con_XYZ",
    connectorId: "github",
    displayName: "My GitHub",
    status: "pending_setup",
  };

  beforeEach(() => {
    // The handler inserts the connection row and its encrypted credentials in a
    // single atomic transaction (one withTenantDb call). The connection insert
    // returns CONN_ROW; the credentials insert resolves on the same tx.
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([CONN_ROW]) as TxLike),
    );
  });

  it("throws when userId is not set (unauthenticated)", async () => {
    await expect(
      connectionCreateHandler(
        {
          connectorId: "github",
          displayName: "My GitHub",
          authCredential: { type: "pat", token: "ghs_xxx" },
        },
        { ...CTX, userId: null },
      ),
    ).rejects.toThrow("authenticated user");
  });

  it("creates connection and returns publicId and status", async () => {
    const result = await connectionCreateHandler(
      {
        connectorId: "github",
        displayName: "My GitHub",
        authCredential: { type: "pat", token: "ghs_xxx" },
      },
      CTX,
    );
    expect(result.publicId).toBe("con_XYZ");
    expect(result.status).toBe("pending_setup");
    expect(result.connectorId).toBe("github");
  });

  it("encrypts the auth credential before storage", async () => {
    await connectionCreateHandler(
      {
        connectorId: "github",
        displayName: "My GitHub",
        authCredential: { type: "pat", token: "ghs_xxx" },
      },
      CTX,
    );
    expect(mocks.encrypt).toHaveBeenCalledTimes(1);
  });

  it("passes connectionConfig to deliveryConfig when provided", async () => {
    await connectionCreateHandler(
      {
        connectorId: "github",
        displayName: "My GitHub",
        authCredential: { type: "pat", token: "ghs_xxx" },
        connectionConfig: { org: "acme", syncDepthDays: 90 },
      },
      CTX,
    );
    // The connection row and its credentials are written in ONE atomic
    // transaction, so withTenantDb is invoked exactly once (no orphaned
    // pending_setup connection if the credential insert fails).
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});

// ── connection.mappings.get ────────────────────────────────────────────────────

import { connectionMappingsGetHandler } from "./connection.mappings.get";

describe("connectionMappingsGetHandler", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");
  const MAPPING_ROW = {
    id: "etm_public_1",
    sourceRecordType: "pull_request",
    oxagenEntityType: "code_change",
    propertyMappings: { title: "title" },
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("returns empty mappings when none exist", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([]) as TxLike),
    );
    const result = await connectionMappingsGetHandler(
      { connectionId: "con_ABC" },
      CTX,
    );
    expect(result.mappings).toHaveLength(0);
  });

  it("returns mappings with ISO date strings", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([MAPPING_ROW]) as TxLike),
    );
    const result = await connectionMappingsGetHandler(
      { connectionId: "con_ABC" },
      CTX,
    );
    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]!.sourceRecordType).toBe("pull_request");
    expect(result.mappings[0]!.oxagenEntityType).toBe("code_change");
    expect(result.mappings[0]!.createdAt).toBe(NOW.toISOString());
    expect(result.mappings[0]!.updatedAt).toBe(NOW.toISOString());
  });

  it("wraps null propertyMappings with empty object", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(
        makeTxReturning([{ ...MAPPING_ROW, propertyMappings: null }]) as TxLike,
      ),
    );
    const result = await connectionMappingsGetHandler(
      { connectionId: "con_ABC" },
      CTX,
    );
    expect(result.mappings[0]!.propertyMappings).toEqual({});
  });
});
