/**
 * Unit tests for the privacy.data.erase handler (GDPR Art. 17 — right to erasure).
 *
 * Mocks:
 *   - @oxagen/database          → withSystemDb (routes to a fluent tx mock); schema kept real
 *   - @oxagen/database/security → emitSecurityEvent
 *   - ./event-client            → eventClient.send (async Inngest dispatch)
 *   - ./logger                  → logger.info
 *
 * Scenarios:
 *   1. No authenticated user            → throws Unauthorized
 *   2. No orgId in context              → throws Forbidden
 *   3. org scope without input.orgId    → throws (orgId required)
 *   4. org scope, lowercase "owner"     → SUCCEEDS  ← regression guard for the
 *      "Owner" vs "owner" case bug that blocked every legitimate owner.
 *   5. org scope, non-owner ("admin")   → throws Forbidden
 *   6. org scope, no membership row     → throws Forbidden (IDOR guard)
 *   7. user scope                       → SUCCEEDS without any role check, revokes
 *      sessions, emits security event + Inngest job, returns queued.
 *   8. org scope, input.orgId ≠ ctx.orgId → throws Forbidden  ← the recheck
 *      evaluates the governed org, so a target naming another org had its own
 *      erase_data deny skipped while being scheduled for hard-delete.
 *   9. org scope, deny in the target org → throws Forbidden, and the IAM read
 *      was made about the org being erased.
 *  10. org scope, same org, nothing denying → still SUCCEEDS.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// Narrow shapes for the mocked call args we assert on (avoids `any` while
// staying robust under noUncheckedIndexedAccess via `.at()`).
type EmittedEvent = { eventType: string };
type InngestEvent = { name: string; data: { scope: string } };
const firstArg = <T>(fn: { mock: { calls: unknown[][] } }): T | undefined =>
  fn.mock.calls.at(0)?.at(0) as T | undefined;

// ── @oxagen/tenancy mock ─────────────────────────────────────────────────────
// The policy re-check enters a tenant scope before reading IAM, because
// `fetchAuthz` reads org-wide and `runInTenantScope` validates both ids as
// UUIDs. This file's fixtures use opaque ids, so the scope entry is a
// passthrough here; `privacy.data.export.status.test.ts` runs the real one
// against UUID fixtures.
vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
  };
});

// ── @oxagen/iam mock ─────────────────────────────────────────────────────────
// The org branch now asks the IAM resolver whether an explicit rule has
// revoked the capability: the revocation path a membership read cannot see.
// The resolver itself runs for real; only its Postgres read is replaced. The
// default is an organisation with nothing configured, so nothing is revoked
// and these tests exercise the role rules as before.
const authz = vi.hoisted(() => ({
  value: {
    principal: null as unknown,
    grants: [] as unknown[],
    roles: [] as unknown[],
    roleGrants: [] as unknown[],
    policies: [] as unknown[],
  },
}));
// Keyed by the org `fetchAuthz` is asked about, so a test can write a rule in
// one organisation and prove the handler reads the right one. Falls back to
// `authz.value` for the single-org tests.
const authzByOrg = vi.hoisted(
  () => ({ value: {} }) as { value: Record<string, unknown> },
);
const fetchAuthzCalls = vi.hoisted(() => ({ orgIds: [] as string[] }));
vi.mock("@oxagen/iam", () => ({
  emitAudit: () => Promise.resolve(),
  fetchAuthz: (args: { orgId: string }) => {
    fetchAuthzCalls.orgIds.push(args.orgId);
    return Promise.resolve(authzByOrg.value[args.orgId] ?? authz.value);
  },
}));

// ── @oxagen/database/security mock ───────────────────────────────────────────
const mockEmitSecurityEvent = vi.fn();
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mockEmitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

// ── ./event-client mock (async Inngest dispatch) ─────────────────────────────
const mockEventSend = vi.fn().mockResolvedValue(undefined);
vi.mock("./event-client", () => ({
  eventClient: { send: mockEventSend },
}));

// ── ./logger mock ────────────────────────────────────────────────────────────
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── @oxagen/database mock ────────────────────────────────────────────────────
// A single fluent tx object services every chain the handler builds:
//   select().from().where().limit()           → roleResult
//   insert().values().returning()              → insertResult
//   delete().where()                           → awaited & ignored
// `where` returns the tx so it works both mid-chain (before .limit) and as the
// terminal of the session delete (await of a plain object resolves to itself).
let roleResult: Array<{ role: string }> = [];
const insertResult = [{ id: "11111111-1111-4111-8111-111111111111" }];

const tx = {
  select: vi.fn(() => tx),
  from: vi.fn(() => tx),
  where: vi.fn(() => tx),
  limit: vi.fn(() => Promise.resolve(roleResult)),
  insert: vi.fn(() => tx),
  values: vi.fn(() => tx),
  returning: vi.fn(() => Promise.resolve(insertResult)),
  delete: vi.fn(() => tx),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: (fn: (t: typeof tx) => unknown) => fn(tx),
  };
});

const { privacyDataEraseHandler } = await import("./privacy.data.erase");

// ── Helpers ──────────────────────────────────────────────────────────────────
const ORG_ID = "22222222-2222-4222-8222-222222222222";
/** A second organisation the caller also owns. */
const OTHER_ORG_ID = "33333333-3333-4333-8333-333333333333";

/** An IAM read in which `roleGrants` carries one explicit effect for the owner. */
function authzWithOwnerEffect(
  orgId: string,
  effect: "allow" | "deny" | "require_approval",
) {
  return {
    principal: { id: "p_1", kind: "human", orgId, workspaceId: null },
    grants: [],
    roles: [
      {
        id: "r_1",
        name: "Owner",
        scopeKind: "org",
        orgId,
        principalIds: ["p_1"],
        isSystemDefault: true,
      },
    ],
    roleGrants: [{ roleId: "r_1", capabilityId: "erase_data", effect }],
    policies: [],
  };
}

function makeCtx(
  overrides: Partial<CapabilityContext> = {},
): CapabilityContext {
  return {
    userId: "user-1",
    apiKeyId: null,
    orgId: ORG_ID,
    workspaceId: "ws-1",
    surface: "api",
    requestId: "req-1",
    messageId: null,
    ...overrides,
  } as CapabilityContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  roleResult = [];
  authzByOrg.value = {};
  fetchAuthzCalls.orgIds = [];
  authz.value = {
    principal: null,
    grants: [],
    roles: [],
    roleGrants: [],
    policies: [],
  };
  // Deterministic effectiveAt and immediate-erasure path for assertions.
  process.env.PRIVACY_ERASURE_GRACE_DAYS = "0";
});

describe("privacy.data.erase handler", () => {
  it("throws Unauthorized when no authenticated user", async () => {
    await expect(
      privacyDataEraseHandler(
        { scope: "user", confirm: true },
        makeCtx({ userId: undefined }),
      ),
    ).rejects.toThrow(/Unauthorized/);
  });

  it("throws Forbidden when no orgId in context", async () => {
    await expect(
      privacyDataEraseHandler(
        { scope: "user", confirm: true },
        makeCtx({ orgId: undefined }),
      ),
    ).rejects.toThrow(/Forbidden/);
  });

  it("throws when org scope is missing input.orgId", async () => {
    await expect(
      privacyDataEraseHandler({ scope: "org", confirm: true }, makeCtx()),
    ).rejects.toThrow(/orgId is required/);
  });

  it("REGRESSION: org scope succeeds for a lowercase 'owner' membership role", async () => {
    roleResult = [{ role: "owner" }];

    const result = await privacyDataEraseHandler(
      { scope: "org", orgId: ORG_ID, confirm: true },
      makeCtx(),
    );

    expect(result.status).toBe("queued");
    expect(result.requestId).toBe(insertResult[0]?.id);
    expect(typeof result.effectiveAt).toBe("string");
    // org-scope erasure must emit the org-specific security event...
    expect(mockEmitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(firstArg<EmittedEvent>(mockEmitSecurityEvent)?.eventType).toBe(
      "privacy.org_erasure_requested",
    );
    // ...and dispatch the async hard-delete job.
    expect(mockEventSend).toHaveBeenCalledTimes(1);
    const orgJob = firstArg<InngestEvent>(mockEventSend);
    expect(orgJob?.name).toBe("privacy/erasure.execute");
    expect(orgJob?.data?.scope).toBe("org");
    // sessions are revoked (delete chain invoked)
    expect(tx.delete).toHaveBeenCalled();
  });

  // An explicit `deny` against `erase_data` is a second revocation path, and
  // `org_users.role` cannot see it: the owner is still the owner. Below the
  // enterprise tier the kernel cannot see it either: its gate answers
  // `tier_gate → allow` before any policy is read, so without this check an
  // organisation that had explicitly forbidden erasure could still have every
  // record in it scheduled for hard-delete.
  it("throws Forbidden for org scope while an explicit erase_data deny stands", async () => {
    roleResult = [{ role: "owner" }];
    authz.value = {
      principal: {
        id: "p_1",
        kind: "human",
        orgId: ORG_ID,
        workspaceId: null,
      },
      grants: [],
      roles: [
        {
          id: "r_1",
          name: "Owner",
          scopeKind: "org",
          orgId: ORG_ID,
          principalIds: ["p_1"],
          isSystemDefault: true,
        },
      ],
      roleGrants: [
        { roleId: "r_1", capabilityId: "erase_data", effect: "deny" },
      ],
      policies: [],
    };
    await expect(
      privacyDataEraseHandler(
        { scope: "org", orgId: ORG_ID, confirm: true },
        makeCtx(),
      ),
    ).rejects.toThrow(/erase_data policy/);
    expect(mockEventSend).not.toHaveBeenCalled();
  });

  it("throws Forbidden for org scope when the member is not an owner", async () => {
    roleResult = [{ role: "admin" }];
    await expect(
      privacyDataEraseHandler(
        { scope: "org", orgId: ORG_ID, confirm: true },
        makeCtx(),
      ),
    ).rejects.toThrow(/requires owner role/);
    expect(mockEventSend).not.toHaveBeenCalled();
  });

  it("throws Forbidden for org scope when the user has no membership row (IDOR guard)", async () => {
    roleResult = [];
    await expect(
      privacyDataEraseHandler(
        { scope: "org", orgId: ORG_ID, confirm: true },
        makeCtx(),
      ),
    ).rejects.toThrow(/Forbidden/);
    expect(mockEventSend).not.toHaveBeenCalled();
  });

  it("user scope succeeds without a role check and emits the user erasure event", async () => {
    // No roleResult needed — user scope must never query org membership.
    const result = await privacyDataEraseHandler(
      { scope: "user", confirm: true },
      makeCtx(),
    );

    expect(result.status).toBe("queued");
    expect(tx.select).not.toHaveBeenCalled(); // role check skipped for user scope
    expect(firstArg<EmittedEvent>(mockEmitSecurityEvent)?.eventType).toBe(
      "privacy.erasure_requested",
    );
    expect(mockEventSend).toHaveBeenCalledTimes(1);
    expect(firstArg<InngestEvent>(mockEventSend)?.data?.scope).toBe("user");
  });

  // ── The erasure target must be the governed organisation ──────────────────
  //
  // The recheck above evaluates `ctx.orgId`. Before the equality check, an
  // owner of two organisations could invoke through A while naming B in the
  // body: the policy of A decided, and B was scheduled for an irreversible
  // hard-delete with its own explicit `erase_data` deny never read. Erasure
  // does not come back, so a control that was not consulted is not a control.
  it("REGRESSION: refuses an org erasure whose input.orgId is not the governed org", async () => {
    roleResult = [{ role: "owner" }];
    // Nothing revoked in the governed org; the deny lives in the target.
    authzByOrg.value = {
      [OTHER_ORG_ID]: authzWithOwnerEffect(OTHER_ORG_ID, "deny"),
    };

    await expect(
      privacyDataEraseHandler(
        { scope: "org", orgId: OTHER_ORG_ID, confirm: true },
        makeCtx({ orgId: ORG_ID }),
      ),
    ).rejects.toThrow(/must be requested in that organization's own context/);

    // Nothing was scheduled, and the policy of the governed org was never even
    // consulted on another org's behalf.
    expect(mockEventSend).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(fetchAuthzCalls.orgIds).toEqual([]);
  });

  it("REGRESSION: an explicit erase_data deny in the target org stops the erasure", async () => {
    roleResult = [{ role: "owner" }];
    authzByOrg.value = {
      [ORG_ID]: authzWithOwnerEffect(ORG_ID, "deny"),
    };

    await expect(
      privacyDataEraseHandler(
        { scope: "org", orgId: ORG_ID, confirm: true },
        makeCtx({ orgId: ORG_ID }),
      ),
    ).rejects.toThrow(/erase_data policy/);
    // The question was asked about the organisation being erased.
    expect(fetchAuthzCalls.orgIds).toEqual([ORG_ID]);
    expect(mockEventSend).not.toHaveBeenCalled();
  });

  it("the same-org path still queues the erasure when nothing denies it", async () => {
    roleResult = [{ role: "owner" }];
    authzByOrg.value = {
      [ORG_ID]: authzWithOwnerEffect(ORG_ID, "allow"),
    };

    const result = await privacyDataEraseHandler(
      { scope: "org", orgId: ORG_ID, confirm: true },
      makeCtx({ orgId: ORG_ID }),
    );

    expect(result.status).toBe("queued");
    expect(fetchAuthzCalls.orgIds).toEqual([ORG_ID]);
    expect(mockEventSend).toHaveBeenCalledTimes(1);
  });
});
