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
import type { RoleFixture } from "./test-utils/role-tx";

// ── mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  encrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
  getConnector: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
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
import { schema } from "@oxagen/database";
import { isHandlerError } from "@oxagen/oxagen";

describe("connectionCreateHandler", () => {
  const CONN_ROW = {
    id: "uuid-conn-1",
    publicId: "con_XYZ",
    connectorId: "github",
    displayName: "My GitHub",
    status: "pending_setup",
  };

  const INPUT = {
    connectorId: "github",
    displayName: "My GitHub",
    authCredential: { type: "pat", token: "ghs_xxx" },
  };

  /** Whether a drizzle SQL tree binds `value` as a parameter (mirrors role-tx.ts). */
  function binds(
    node: unknown,
    value: string,
    seen = new Set<unknown>(),
  ): boolean {
    if (node === value) return true;
    if (typeof node !== "object" || node === null || seen.has(node))
      return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some((n) => binds(n, value, seen));
    if ("queryChunks" in node)
      return binds((node as { queryChunks: unknown }).queryChunks, value, seen);
    if ("value" in node)
      return binds((node as { value: unknown }).value, value, seen);
    return false;
  }

  function roleRowsFor(
    table: unknown,
    where: unknown,
    roles: RoleFixture,
  ): unknown[] {
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments) {
      const role = binds(where, "workspace")
        ? (roles.workspace ?? null)
        : roles.org;
      return role === null ? [] : [{ roleName: role }];
    }
    return [];
  }

  /**
   * A combined `withTenantDb` double for `connectionCreateHandler`: `assertOrgRole`
   * runs FOR REAL against it (`role-tx.ts`'s shape for `principals` /
   * `principalRoleAssignments`), and the connection insert resolves to `connRow`
   * on the same tx — because the handler's role gate and its write share one seam
   * (`withOrgDb` aliases `withTenantDb`, ADR-086), and a test that mocked the
   * gate's own decision would prove nothing about whether `checkIAM`'s
   * non-enterprise fast path (CLAUDE.md "Gotchas") is actually closed by this
   * handler, only that the contract's declared shape exists (#3258).
   */
  function connectionCreateTx(roles: RoleFixture, connRow: unknown) {
    return {
      select: () => ({
        from: (table: unknown) => {
          let where: unknown;
          const chain = {
            innerJoin: () => chain,
            where: (cond: unknown) => {
              where = cond;
              return chain;
            },
            limit: () => Promise.resolve(roleRowsFor(table, where, roles)),
          };
          return chain;
        },
      }),
      insert: () => ({
        values: () => ({ returning: async () => [connRow] }),
      }),
    };
  }

  function roles(fixture: RoleFixture) {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(connectionCreateTx(fixture, CONN_ROW) as unknown as TxLike),
    );
  }

  beforeEach(() => {
    // Default: an org Owner, matching the contract's Owner/Admin/workspace-Owner
    // restriction (connection.create.ts). Tests that need a different role call
    // roles({...}) themselves.
    roles({ org: "Owner" });
  });

  it("throws when userId is not set (unauthenticated)", async () => {
    await expect(
      connectionCreateHandler(INPUT, { ...CTX, userId: null }),
    ).rejects.toThrow("authenticated user");
  });

  describe("role gate (#3258)", () => {
    it.each(["Member", "Billing"])(
      "refuses an org %s with no workspace role as forbidden, before writing a row",
      async (role) => {
        roles({ org: role, workspace: null });
        const err = await connectionCreateHandler(INPUT, CTX).then(
          () => null,
          (e: unknown) => e,
        );
        expect(isHandlerError(err)).toBe(true);
        expect(err).toMatchObject({ code: "forbidden" });
        // Refused before the insert — no orphaned pending_setup row.
        expect(mocks.encrypt).not.toHaveBeenCalled();
      },
    );

    it("allows an org Admin with no workspace role", async () => {
      roles({ org: "Admin", workspace: null });
      const result = await connectionCreateHandler(INPUT, CTX);
      expect(result.publicId).toBe("con_XYZ");
    });

    it("allows a workspace Owner who holds no org role — the contract's workspace leg", async () => {
      roles({ org: null, workspace: "Owner" });
      const result = await connectionCreateHandler(INPUT, CTX);
      expect(result.publicId).toBe("con_XYZ");
    });

    it("refuses a workspace Member who holds no org role", async () => {
      roles({ org: null, workspace: "Member" });
      const err = await connectionCreateHandler(INPUT, CTX).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isHandlerError(err)).toBe(true);
      expect(err).toMatchObject({ code: "forbidden" });
    });

    it("refuses when checkIAM's non-enterprise fast path would otherwise have let the caller through — the handler is the only gate on this tier", async () => {
      // No IAM runtime is set up in this suite at all (no
      // setKernelIAMRuntime call): the handler is invoked directly, exactly
      // as an org below the enterprise tier reaches it once checkIAM's
      // fast path admits the caller (CLAUDE.md "Gotchas"). Refusal here
      // proves the handler's own assertOrgRole is what stops a Member —
      // not IAM, which this suite never engages.
      roles({ org: "Member" });
      await expect(connectionCreateHandler(INPUT, CTX)).rejects.toMatchObject({
        code: "forbidden",
      });
    });
  });

  it("creates connection and returns publicId and status", async () => {
    const result = await connectionCreateHandler(INPUT, CTX);
    expect(result.publicId).toBe("con_XYZ");
    expect(result.status).toBe("pending_setup");
    expect(result.connectorId).toBe("github");
  });

  it("encrypts the auth credential before storage", async () => {
    await connectionCreateHandler(INPUT, CTX);
    expect(mocks.encrypt).toHaveBeenCalledTimes(1);
  });

  it("passes connectionConfig to deliveryConfig when provided", async () => {
    await connectionCreateHandler(
      { ...INPUT, connectionConfig: { org: "acme", syncDepthDays: 90 } },
      CTX,
    );
    // One call for the role gate's org-role lookup (the default fixture is an
    // org Owner, so the workspace leg never runs) and one further atomic
    // transaction for the connection row and its credentials — no orphaned
    // pending_setup connection if the credential insert failed.
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
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
