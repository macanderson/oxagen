/**
 * Unit tests for api.key.revoke handler.
 *
 * Coverage targets:
 *   - no authenticated principal → CapabilityError authz_denied
 *   - missing orgId → CapabilityError authz_denied
 *   - resolveActorRole returns null → CapabilityError authz_denied
 *   - resolveActorRole returns non-Owner/Admin role → CapabilityError authz_denied
 *   - key not found / already revoked → Error("Not found...")
 *   - happy path (Owner role, key exists) → returns revoked: true + revokedAt ISO string
 *   - happy path (Admin role) → works the same
 *   - emitSecurityEvent is called after successful revoke
 *   - apiKeyId as actor (machine-to-machine) → succeeds
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CapabilityError } from "@oxagen/oxagen/kernel";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { apiKeyRevokeHandler } from "./api.key.revoke";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── shared fixtures ───────────────────────────────────────────────────────────

const BASE_INPUT = { keyPublicId: "aky_test123" };

/** Build the Drizzle tx mock for resolveActorRole. */
function makeRoleResolutionTx(
  principalId: string | null,
  roleName: string | null,
) {
  let selectCallCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        const rows = principalId ? [{ id: principalId }] : [];
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows),
            }),
          }),
        };
      }
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
 * Build the Drizzle tx mock used in the soft-delete step.
 * The handler runs two operations inside one withTenantDb call:
 *   1. select existing key row
 *   2. update the row
 */
function makeSoftDeleteTx(
  existingRow: { id: string; publicId: string } | null,
) {
  let selectCallCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      const rows = existingRow ? [existingRow] : [];
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      };
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
}

/**
 * Wire up `withTenantDb` for the happy-path sequence:
 *   call 1 → resolveActorRole
 *   call 2 → soft-delete (select + update)
 */
function setupHappyPath(
  roleName = "Owner",
  existingRow: { id: string; publicId: string } | null = {
    id: "key-uuid-1",
    publicId: "aky_test123",
  },
) {
  let callCount = 0;
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => {
      callCount++;
      if (callCount === 1) {
        return fn(makeRoleResolutionTx("principal-uuid-1", roleName));
      }
      return fn(makeSoftDeleteTx(existingRow));
    },
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("api.key.revoke handler — auth + scope guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it("throws CapabilityError authz_denied when both userId and apiKeyId are null", async () => {
    const anonCtx: CapabilityContext = makeCTX({
      userId: null,
      apiKeyId: null,
    });
    await expect(apiKeyRevokeHandler(BASE_INPUT, anonCtx)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "revoke_api_key",
    );
  });

  it("throws CapabilityError authz_denied when orgId is missing", async () => {
    // orgId is string in CapabilityContext but we force-null to exercise the guard
    const noOrgCtx = {
      ...TEST_CTX,
      orgId: null,
    } as unknown as CapabilityContext;
    await expect(apiKeyRevokeHandler(BASE_INPUT, noOrgCtx)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "revoke_api_key",
    );
  });
});

describe("api.key.revoke handler — role gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws CapabilityError authz_denied when no principal row exists", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeRoleResolutionTx(null, null));
        return fn(
          makeSoftDeleteTx({ id: "key-uuid-1", publicId: "aky_test123" }),
        );
      },
    );

    await expect(apiKeyRevokeHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "revoke_api_key",
    );
  });

  it("throws CapabilityError authz_denied when actor has Member role (insufficient)", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1)
          return fn(makeRoleResolutionTx("principal-uuid-1", "Member"));
        return fn(
          makeSoftDeleteTx({ id: "key-uuid-1", publicId: "aky_test123" }),
        );
      },
    );

    await expect(apiKeyRevokeHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "revoke_api_key",
    );
  });

  it("throws CapabilityError authz_denied when actor has Viewer role (insufficient)", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1)
          return fn(makeRoleResolutionTx("principal-uuid-1", "Viewer"));
        return fn(
          makeSoftDeleteTx({ id: "key-uuid-1", publicId: "aky_test123" }),
        );
      },
    );

    await expect(apiKeyRevokeHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CapabilityError &&
        e.code === "authz_denied" &&
        e.capability === "revoke_api_key",
    );
  });
});

describe("api.key.revoke handler — key not found", () => {
  it("throws Error('Not found...') when key does not exist or is already revoked", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1)
          return fn(makeRoleResolutionTx("principal-uuid-1", "Owner"));
        return fn(makeSoftDeleteTx(null)); // no existing row
      },
    );

    await expect(apiKeyRevokeHandler(BASE_INPUT, TEST_CTX)).rejects.toThrow(
      "Not found: API key does not exist, is not in this org, or is already revoked",
    );
  });

  it("not-found error is a plain Error, not a CapabilityError", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1)
          return fn(makeRoleResolutionTx("principal-uuid-1", "Owner"));
        return fn(makeSoftDeleteTx(null));
      },
    );

    await expect(apiKeyRevokeHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && !(e instanceof CapabilityError),
    );
  });
});

describe("api.key.revoke handler — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath("Owner");
  });

  it("returns revoked:true and keyPublicId on success", async () => {
    const result = await apiKeyRevokeHandler(BASE_INPUT, TEST_CTX);
    expect(result.revoked).toBe(true);
    expect(result.keyPublicId).toBe("aky_test123");
  });

  it("returns a valid ISO-8601 revokedAt timestamp", async () => {
    const before = new Date();
    const result = await apiKeyRevokeHandler(BASE_INPUT, TEST_CTX);
    const after = new Date();
    const revokedAt = new Date(result.revokedAt);
    expect(revokedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(revokedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(result.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("works with Admin role", async () => {
    vi.clearAllMocks();
    setupHappyPath("Admin");
    const result = await apiKeyRevokeHandler(BASE_INPUT, TEST_CTX);
    expect(result.revoked).toBe(true);
  });

  it("emits security event after successful revoke", async () => {
    await apiKeyRevokeHandler(BASE_INPUT, TEST_CTX);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "api_key.revoked",
        capability: "revoke_api_key",
        outcome: "success",
        orgId: TEST_CTX.orgId,
      }),
    );
  });

  it("withTenantDb is called twice: once for role resolution, once for soft-delete", async () => {
    await apiKeyRevokeHandler(BASE_INPUT, TEST_CTX);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });
});

describe("api.key.revoke handler — apiKeyId as actor", () => {
  it("succeeds when userId is null but apiKeyId is set (machine-to-machine auth)", async () => {
    vi.clearAllMocks();
    setupHappyPath("Admin");
    const machineCtx: CapabilityContext = makeCTX({
      userId: null,
      apiKeyId: "aky_machine123",
    });
    const result = await apiKeyRevokeHandler(BASE_INPUT, machineCtx);
    expect(result.revoked).toBe(true);
  });
});
