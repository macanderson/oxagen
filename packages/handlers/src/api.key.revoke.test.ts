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
interface ExistingKeyRow {
  id: string;
  publicId: string;
  workspaceId?: string | null;
  /** The stored jsonb scope. The reserved-purpose guard reads it from here. */
  scope?: unknown;
}

function makeSoftDeleteTx(existingRow: ExistingKeyRow | null) {
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
  existingRow: ExistingKeyRow | null = {
    id: "key-uuid-1",
    publicId: "aky_test123",
    scope: {},
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

/**
 * The generic revoke must refuse a credential whose revocation means more than
 * soft-deleting the key — and must NOT refuse one that has nowhere else to go.
 *
 * The sharp case is `tacho_host_v1`: `revokeHostEnrollment` does three writes
 * and this handler does one, so letting it through soft-deletes the key while
 * `tacho_hosts.status` still reads `active` and no revoke command is queued —
 * the collector is dead and the fleet record says it is live.
 *
 * The test each refusal has to pass is that **the path it names achieves what
 * the refused operation was for**. `cli_session_v1` fails that test and is
 * therefore NOT refused; the case below pins it, because an earlier revision of
 * the guard did refuse it and these very tests passed while the hole opened.
 * Every case here asserted a purpose was refused, so a suite shaped like that
 * confirms whatever set it is handed. The revocable case is the one that
 * constrains the set.
 *
 * Asserted per purpose rather than in aggregate, and each refusal checks the
 * message NAMES the owning path: a refusal with no destination is how an
 * operator ends up reaching for raw SQL. The ordering case matters too — the
 * refusal happens BEFORE the update, so a refused revoke leaves the row
 * untouched rather than half-applying.
 */
describe("api.key.revoke handler — reserved server-owned purposes", () => {
  const RESERVED: [string, RegExp][] = [
    ["tacho_host_v1", /revoke_tacho_enrollment/],
    ["agent_credential_v1", /rotate_agent_credential|retire_agent/],
  ];

  /**
   * One entry per purpose that MUST stay revocable, with why. These are the
   * cases that constrain the refusal set; the RESERVED cases above only confirm
   * whatever set they are handed.
   */
  const MUST_STAY_REVOCABLE: [string, string][] = [
    [
      "cli_session_v1",
      "oxagen login only mints another key and oxagen logout is local-only, so refusing leaves remove_org_member — which also strips org access — as the only revocation",
    ],
    [
      "stella_operational_telemetry_v1",
      "no Stella revocation capability exists and enrollment writes nothing but auth.api_keys, so the soft-delete here is the whole job",
    ],
  ];

  function setupWithPurpose(purpose: string) {
    setupHappyPath("Owner", {
      id: "key-uuid-1",
      publicId: "aky_test123",
      scope: { purpose },
    });
  }

  it.each(RESERVED)(
    "refuses a %s key and names the path that owns it",
    async (purpose, namesPath) => {
      vi.clearAllMocks();
      setupWithPurpose(purpose);
      await expect(
        apiKeyRevokeHandler(BASE_INPUT, TEST_CTX),
      ).rejects.toThrowError(namesPath);
    },
  );

  it.each(RESERVED)(
    "refuses a %s key with a CapabilityError, not a plain Error",
    async (purpose) => {
      vi.clearAllMocks();
      setupWithPurpose(purpose);
      await expect(
        apiKeyRevokeHandler(BASE_INPUT, TEST_CTX),
      ).rejects.toBeInstanceOf(CapabilityError);
    },
  );

  it("refuses before the update, so the row is left untouched", async () => {
    vi.clearAllMocks();
    const tx = makeSoftDeleteTx({
      id: "key-uuid-1",
      publicId: "aky_test123",
      scope: { purpose: "tacho_host_v1" },
    });
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1)
          return fn(makeRoleResolutionTx("principal-uuid-1", "Owner"));
        return fn(tx);
      },
    );

    await expect(apiKeyRevokeHandler(BASE_INPUT, TEST_CTX)).rejects.toThrow();
    expect(tx.update).not.toHaveBeenCalled();
  });

  /**
   * The cases that constrain the refusal set, and the ones whose absence let an
   * earlier revision of this guard remove two revocation paths in one commit.
   *
   * Each asserts the soft-delete ACTUALLY RAN, not merely that nothing threw —
   * a refusal throws before the update, so `tx.update` is the discriminator.
   * If a governed revocation path is ever built for one of these purposes, the
   * corresponding expectation is what has to change, deliberately, with the
   * handler header updated to name it.
   */
  it.each(MUST_STAY_REVOCABLE)("REVOKES a %s key — %s", async (purpose) => {
    vi.clearAllMocks();
    const tx = makeSoftDeleteTx({
      id: "key-uuid-1",
      publicId: "aky_test123",
      scope: { purpose },
    });
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1)
          return fn(makeRoleResolutionTx("principal-uuid-1", "Owner"));
        return fn(tx);
      },
    );

    const result = await apiKeyRevokeHandler(BASE_INPUT, TEST_CTX);
    expect(result.revoked).toBe(true);
    expect(tx.update).toHaveBeenCalled();
  });

  it("revokes an operator key, which carries no reserved purpose", async () => {
    vi.clearAllMocks();
    setupHappyPath("Owner", {
      id: "key-uuid-1",
      publicId: "aky_test123",
      scope: { environments: ["prod"] },
    });
    const result = await apiKeyRevokeHandler(BASE_INPUT, TEST_CTX);
    expect(result.revoked).toBe(true);
  });

  // A key minted before the scope column carried anything. The guards read
  // `purpose` off the stored scope, so a null scope must not be mistaken for a
  // reserved one and lock an operator out of revoking their own key.
  it("revokes a key whose stored scope is null", async () => {
    vi.clearAllMocks();
    setupHappyPath("Owner", {
      id: "key-uuid-1",
      publicId: "aky_test123",
      scope: null,
    });
    const result = await apiKeyRevokeHandler(BASE_INPUT, TEST_CTX);
    expect(result.revoked).toBe(true);
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
