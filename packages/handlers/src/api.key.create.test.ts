/**
 * Unit tests for api.key.create handler.
 *
 * Coverage targets:
 *   - no authenticated principal (userId and apiKeyId both null) → CapabilityError authz_denied
 *   - missing orgId → CapabilityError authz_denied
 *   - missing workspaceId → CapabilityError authz_denied
 *   - resolveActorRole returns null (no principal row) → CapabilityError authz_denied
 *   - resolveActorRole returns non-Owner/Admin role (e.g. "Member") → CapabilityError authz_denied
 *   - happy path Owner role → inserts row, returns rawKey once, emits security event
 *   - happy path Admin role → works the same
 *   - missing keyPrefix → internal error
 *   - app surface → returns render directive
 *   - api surface → no render directive
 *   - emitSecurityEvent is called after successful create
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { HandlerError } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { apiKeyCreateHandler } from "./api.key.create";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── shared fixtures ───────────────────────────────────────────────────────────

const BASE_INPUT = { name: "My API Key", scope: {} as Record<string, unknown> };

const INSERTED_ROW = {
  id: "key-uuid-1",
  publicId: "aky_test123",
  name: "My API Key",
  keyPrefix: "ox_abc123ef",
  expiresAt: null as Date | null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

/** Build the Drizzle chain mock for resolveActorRole called within withTenantDb. */
function makeRoleResolutionTx(
  principalId: string | null,
  roleName: string | null,
) {
  // Two sequential select chains are used inside resolveActorRole:
  //   1. select principal id
  //   2. select role name (innerJoin)
  let selectCallCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // principals query
        const rows = principalId ? [{ id: principalId }] : [];
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows),
            }),
          }),
        };
      }
      // principalRoleAssignments + roles join query
      const rows = roleName ? [{ roleName }] : [];
      return {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      };
    }),
  };
}

/**
 * Build the write transaction: the workspace lookup the archival guard makes,
 * then the api_keys insert. `workspace` null stands for a workspace of another
 * org or none at all; an `archivedAt` stands for one that is wound down.
 */
function makeInsertTx(
  rows: unknown[],
  workspace: { name: string; archivedAt: Date | null } | null = {
    name: "Core platform",
    archivedAt: null,
  },
) {
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  });
  // The workspace read takes a row lock; `lock` records the mode it asked for,
  // so a test can hold the guard to its mechanism and not only its answer.
  const lock = vi.fn().mockResolvedValue(workspace ? [workspace] : []);
  return {
    insert,
    lock,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({ for: lock }),
        }),
      }),
    }),
  };
}

/**
 * Wire up `withTenantDb` for the happy-path sequence:
 *   call 1 → resolveActorRole (principal + role selects)
 *   call 2 → api_keys insert
 */
function setupHappyPath(
  roleName = "Owner",
  insertedRows: unknown[] = [INSERTED_ROW],
  workspace: { name: string; archivedAt: Date | null } | null = {
    name: "Core platform",
    archivedAt: null,
  },
) {
  let callCount = 0;
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => {
      callCount++;
      if (callCount === 1) {
        // resolveActorRole
        return fn(makeRoleResolutionTx("principal-uuid-1", roleName));
      }
      // workspace archival guard, then the api_keys insert
      return fn(makeInsertTx(insertedRows, workspace));
    },
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("api.key.create handler — auth + scope guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it("throws CapabilityError authz_denied when both userId and apiKeyId are null", async () => {
    const anonCtx: CapabilityContext = makeCTX({
      userId: null,
      apiKeyId: null,
    });
    await expect(apiKeyCreateHandler(BASE_INPUT, anonCtx)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "create_api_key",
    );
  });

  it("throws CapabilityError authz_denied when orgId is missing", async () => {
    // orgId is string in CapabilityContext, but we force-null to exercise the guard
    const noOrgCtx = {
      ...TEST_CTX,
      orgId: null,
    } as unknown as CapabilityContext;
    await expect(apiKeyCreateHandler(BASE_INPUT, noOrgCtx)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "create_api_key",
    );
  });

  it("throws CapabilityError authz_denied when workspaceId is missing (role check passes but no workspace)", async () => {
    // workspaceId is string in CapabilityContext, but we force-null to exercise the guard
    const noWsCtx = {
      ...TEST_CTX,
      workspaceId: null,
    } as unknown as CapabilityContext;
    await expect(apiKeyCreateHandler(BASE_INPUT, noWsCtx)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "create_api_key",
    );
  });
});

describe("api.key.create handler — role gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws CapabilityError authz_denied when no principal row is found (resolveActorRole returns null)", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) {
          return fn(makeRoleResolutionTx(null, null)); // no principal
        }
        return fn(makeInsertTx([INSERTED_ROW]));
      },
    );

    await expect(apiKeyCreateHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "create_api_key",
    );
  });

  it("throws CapabilityError authz_denied when actor has Member role (insufficient)", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) {
          return fn(makeRoleResolutionTx("principal-uuid-1", "Member")); // Member is not Owner/Admin
        }
        return fn(makeInsertTx([INSERTED_ROW]));
      },
    );

    await expect(apiKeyCreateHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "create_api_key",
    );
  });

  it("throws CapabilityError authz_denied when actor has Viewer role (insufficient)", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) {
          return fn(makeRoleResolutionTx("principal-uuid-1", "Viewer"));
        }
        return fn(makeInsertTx([INSERTED_ROW]));
      },
    );

    await expect(apiKeyCreateHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "create_api_key",
    );
  });
});

describe("api.key.create handler — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath("Owner");
  });

  it("returns rawKey, keyId, publicId, name, keyPrefix, createdAt on success (Owner)", async () => {
    const result = await apiKeyCreateHandler(BASE_INPUT, TEST_CTX);
    expect(result.keyId).toBe(INSERTED_ROW.id);
    expect(result.publicId).toBe(INSERTED_ROW.publicId);
    expect(result.name).toBe(INSERTED_ROW.name);
    expect(result.keyPrefix).toBe(INSERTED_ROW.keyPrefix);
    expect(typeof result.rawKey).toBe("string");
    expect(result.rawKey.startsWith("ox_")).toBe(true);
    expect(result.expiresAt).toBeNull();
    expect(result.createdAt).toBe(INSERTED_ROW.createdAt.toISOString());
  });

  it("returns rawKey that starts with ox_ prefix", async () => {
    const result = await apiKeyCreateHandler(BASE_INPUT, TEST_CTX);
    expect(result.rawKey).toMatch(/^ox_[A-Za-z0-9_-]+$/);
  });

  it("works with Admin role", async () => {
    vi.clearAllMocks();
    setupHappyPath("Admin");
    const result = await apiKeyCreateHandler(BASE_INPUT, TEST_CTX);
    expect(result.keyId).toBe(INSERTED_ROW.id);
  });

  it("emits security event after successful create", async () => {
    await apiKeyCreateHandler(BASE_INPUT, TEST_CTX);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "api_key.created",
        capability: "create_api_key",
        outcome: "success",
        orgId: TEST_CTX.orgId,
      }),
    );
  });

  it("withTenantDb is called twice: once for role resolution, once for insert", async () => {
    await apiKeyCreateHandler(BASE_INPUT, TEST_CTX);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });

  it("returns null expiresAt when no expiry is provided", async () => {
    const result = await apiKeyCreateHandler(
      { name: "No Expiry", scope: {} },
      TEST_CTX,
    );
    expect(result.expiresAt).toBeNull();
  });

  it("passes expiresAt from input to the inserted row", async () => {
    // Row with a non-null expiresAt
    const expiryDate = new Date("2025-12-31T23:59:59.000Z");
    const rowWithExpiry = { ...INSERTED_ROW, expiresAt: expiryDate };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1)
          return fn(makeRoleResolutionTx("principal-uuid-1", "Owner"));
        return fn(makeInsertTx([rowWithExpiry]));
      },
    );

    const result = await apiKeyCreateHandler(
      {
        name: "Expiring Key",
        scope: {},
        expiresAt: "2025-12-31T23:59:59.000Z",
      },
      TEST_CTX,
    );
    expect(result.expiresAt).toBe("2025-12-31T23:59:59.000Z");
  });

  it("throws internal Error when insert returns no row", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1)
          return fn(makeRoleResolutionTx("principal-uuid-1", "Owner"));
        return fn(makeInsertTx([])); // empty → should throw
      },
    );

    await expect(apiKeyCreateHandler(BASE_INPUT, TEST_CTX)).rejects.toThrow(
      "Internal error: failed to create API key row",
    );
  });
});

describe("api.key.create handler — app surface render directive", () => {
  it("returns render directive when surface is 'app'", async () => {
    vi.clearAllMocks();
    setupHappyPath("Owner");
    const appCtx: CapabilityContext = makeCTX({ surface: "app" });
    const result = await apiKeyCreateHandler(BASE_INPUT, appCtx);
    expect(result.render).toBeDefined();
    expect(result.render?.componentId).toBe("api-key-display");
    expect(result.render?.props).toMatchObject({
      keyId: INSERTED_ROW.id,
      publicId: INSERTED_ROW.publicId,
      name: INSERTED_ROW.name,
    });
  });

  it("does not return render directive when surface is 'api'", async () => {
    vi.clearAllMocks();
    setupHappyPath("Owner");
    const apiCtx: CapabilityContext = makeCTX({ surface: "api" });
    const result = await apiKeyCreateHandler(BASE_INPUT, apiCtx);
    expect(result.render).toBeUndefined();
  });

  it("does not return render directive when surface is 'mcp'", async () => {
    vi.clearAllMocks();
    setupHappyPath("Owner");
    const mcpCtx: CapabilityContext = makeCTX({ surface: "mcp" });
    const result = await apiKeyCreateHandler(BASE_INPUT, mcpCtx);
    expect(result.render).toBeUndefined();
  });
});

describe("api.key.create handler — apiKeyId as actor", () => {
  it("succeeds when userId is null but apiKeyId is set (machine-to-machine auth)", async () => {
    vi.clearAllMocks();
    setupHappyPath("Admin");
    const machineCtx: CapabilityContext = makeCTX({
      userId: null,
      apiKeyId: "aky_machine123",
    });
    const result = await apiKeyCreateHandler(BASE_INPUT, machineCtx);
    expect(result.keyId).toBe(INSERTED_ROW.id);
  });
});

describe("api.key.create handler — protected Stella telemetry scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath("Owner");
  });

  it("rejects attempts to mint the reserved Stella telemetry purpose", async () => {
    await expect(
      apiKeyCreateHandler(
        {
          name: "Unauthorized Stella enrollment",
          scope: {
            purpose: "stella_operational_telemetry_v1",
            enrollment_id: "enrollment-1",
          },
        },
        TEST_CTX,
      ),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("rejects attempts to mint the reserved agent credential purpose", async () => {
    await expect(
      apiKeyCreateHandler(
        {
          name: "Unauthorized agent credential",
          scope: {
            purpose: "agent_credential_v1",
            agent_id: "agt_0123456789abcdefghjkmn",
            principal_id: "prn_0123456789abcdefghjkmn",
          },
        },
        TEST_CTX,
      ),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("rejects attempts to mint the reserved Tacho GATEWAY purpose", async () => {
    // The host purpose was guarded here from the start; this one was not, and
    // enrollment mints the gateway key by direct insert rather than through
    // this capability — so refusing it removes no capability from anyone.
    //
    // It matters because `retireEnrollmentKeys` now selects the credentials a
    // host revocation sweeps by their purpose, to stop the sweep reaching keys
    // the enrollment never minted (discussion_r4036214055). A purpose a caller
    // can write for themselves is not a server-owned selector, so leaving this
    // open would have undercut that fix on one of its two values.
    await expect(
      apiKeyCreateHandler(
        {
          name: "Self-asserted gateway",
          scope: {
            purpose: "tacho_gateway_v1",
            host_enrollment_id: "tch_0123456789abcdefghjkmn",
          },
        },
        TEST_CTX,
      ),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("still allows an ordinary key whose scope merely mentions a host enrollment id", async () => {
    // The reviewer's own scenario, from the other side. An Owner may put a
    // host's PUBLIC enrollment id in their own key's metadata; that is not a
    // reserved purpose and must keep working. It is also exactly why the sweep
    // may not select on that id alone.
    await expect(
      apiKeyCreateHandler(
        {
          name: "Ops key that references a host",
          scope: { host_enrollment_id: "tch_0123456789abcdefghjkmn" },
        },
        TEST_CTX,
      ),
    ).resolves.toBeDefined();
  });

  it.each(["cli_session_v1", "ledger_run_v1"])(
    "rejects attempts to mint reserved purpose %s",
    async (purpose) => {
      await expect(
        apiKeyCreateHandler(
          {
            name: "Unauthorized CLI session",
            scope: { purpose },
          },
          TEST_CTX,
        ),
      ).rejects.toMatchObject({ code: "authz_denied" });
      expect(mocks.withTenantDb).not.toHaveBeenCalled();
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it("continues to allow unrelated arbitrary scope", async () => {
    const result = await apiKeyCreateHandler(
      {
        name: "Deployment key",
        scope: { environment: "production", repository: "acme/widgets" },
      },
      TEST_CTX,
    );

    expect(result.keyId).toBe(INSERTED_ROW.id);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
  });
});

describe("api.key.create handler — archived workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // An archived workspace is wound down. Its existing keys stop authenticating
  // (ADR-105) without being revoked, and the Organization › API keys page
  // lists them so an operator can revoke one for good. Minting a new one there
  // is a credential that is dead on arrival and alive again the moment the
  // workspace is restored.
  it("refuses to mint a key into an archived workspace, and inserts nothing (negative)", async () => {
    const archivedAt = new Date("2026-09-01T00:00:00.000Z");
    const insertTx = makeInsertTx([INSERTED_ROW], {
      name: "Sunset",
      archivedAt,
    });
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) {
          return fn(makeRoleResolutionTx("principal-uuid-1", "Owner"));
        }
        return fn(insertTx);
      },
    );

    await expect(apiKeyCreateHandler(BASE_INPUT, makeCTX())).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof HandlerError &&
        e.code === "conflict" &&
        e.reason === "workspace_archived",
    );
    // Nothing minted, and no key.created row claiming one was.
    expect(insertTx.insert).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses a workspace this org does not hold, without inserting (negative)", async () => {
    const insertTx = makeInsertTx([INSERTED_ROW], null);
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) {
          return fn(makeRoleResolutionTx("principal-uuid-1", "Owner"));
        }
        return fn(insertTx);
      },
    );

    await expect(apiKeyCreateHandler(BASE_INPUT, makeCTX())).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof HandlerError &&
        e.code === "not_found" &&
        e.reason === "workspace_not_found",
    );
    expect(insertTx.insert).not.toHaveBeenCalled();
  });

  it("takes a row lock on the workspace, which is what makes the check hold", async () => {
    // The guard's correctness is not "the check is inside the transaction" —
    // that only makes the statements atomic with respect to failure. Under
    // READ COMMITTED an unlocked SELECT snapshots at statement start and
    // `archive_workspace` can commit before the write, so the check would pass
    // on precisely the interleaving its comment claims to prevent.
    //
    // The lock is the mechanism, so it is what the test pins: a future reader
    // deleting `.for("update")` as redundant fails here rather than silently
    // reopening the race.
    const insertTx = makeInsertTx([INSERTED_ROW]);
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) {
          return fn(makeRoleResolutionTx("principal-uuid-1", "Owner"));
        }
        return fn(insertTx);
      },
    );

    await apiKeyCreateHandler(BASE_INPUT, makeCTX());
    expect(insertTx.lock).toHaveBeenCalledWith("update");
  });

  it("mints into a live workspace, as before", async () => {
    setupHappyPath("Owner", [INSERTED_ROW], {
      name: "Core platform",
      archivedAt: null,
    });
    const result = await apiKeyCreateHandler(BASE_INPUT, makeCTX());
    expect(result.keyId).toBe(INSERTED_ROW.id);
  });
});
