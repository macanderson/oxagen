/**
 * Unit tests for org.member.role.change handler.
 *
 * Mocks:
 *   - @oxagen/database          → db() + schema
 *   - @oxagen/database/security → makeSecurityEventInserter
 *   - @oxagen/telemetry         → recordSecurityEvent
 *   - drizzle-orm               → and, eq, isNull
 *
 * Scenarios:
 *   1. No authenticated principal → throws Unauthorized
 *   2. No orgId → throws Forbidden
 *   3. Actor has insufficient role (Member) → throws Forbidden
 *   4. Target not in org → throws Not found (IDOR guard)
 *   5. Requested role does not exist in org → throws with descriptive message
 *   6. Demoting last owner → blocked
 *   7. Happy path → changes role, emits org.role_changed event, returns changed:true
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── @oxagen/database/security mock ───────────────────────────────────────────
// The handler emits through the consolidated registry helper emitSecurityEvent
// (OXA-N1); we mock it directly and assert the event payload.
const mockEmitSecurityEvent = vi.fn();
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mockEmitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

// ── drizzle-orm mock ─────────────────────────────────────────────────────────

// ── @oxagen/database mock ────────────────────────────────────────────────────
const mockTx = {
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    // The handler runs the actor role gate + all reads + writes inside a single
    // withTenantDb (one RLS-scoped transaction) so the authorization check and the
    // mutation are atomic (no TOCTOU). The mock routes to the same fluent tx mock
    // so the call sequence is continuous.
    withTenantDb: async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
      fn(mockTx),
  };
});

const { orgMemberRoleChangeHandler } = await import("./org.member_role.change");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(
  overrides: Partial<CapabilityContext> = {},
): CapabilityContext {
  return {
    userId: "actor-user-id",
    apiKeyId: null,
    orgId: "org-abc",
    workspaceId: "ws-abc",
    surface: "api",
    requestId: "req-456",
    messageId: null,
    ...overrides,
  } as CapabilityContext;
}

function buildSelectMock(calls: unknown[][]) {
  let callCount = 0;
  return vi.fn().mockImplementation(() => {
    const result = calls[callCount] ?? [];
    callCount++;
    const limit = vi.fn().mockResolvedValue(result);
    const where = vi.fn().mockReturnValue({ limit });
    const innerJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ where, innerJoin });
    return { from };
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("orgMemberRoleChangeHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no authenticated principal → throws Unauthorized", async () => {
    const ctx = makeCtx({ userId: null, apiKeyId: null });
    await expect(
      orgMemberRoleChangeHandler({ targetUserId: "t", newRole: "Admin" }, ctx),
    ).rejects.toThrow("Unauthorized");
  });

  it("no orgId → throws Forbidden", async () => {
    const ctx = makeCtx({ orgId: null as unknown as string });
    await expect(
      orgMemberRoleChangeHandler({ targetUserId: "t", newRole: "Admin" }, ctx),
    ).rejects.toThrow("Forbidden");
  });

  it("actor has Member role → throws Forbidden", async () => {
    mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // actor principal
      [{ roleName: "Member" }], // actor PRA = Member
    ]);

    const ctx = makeCtx();
    await expect(
      orgMemberRoleChangeHandler({ targetUserId: "t", newRole: "Admin" }, ctx),
    ).rejects.toThrow("Forbidden");
  });

  it("target not a member → throws Not found (IDOR guard)", async () => {
    mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // actor principal
      [{ roleName: "Admin" }], // actor PRA = Admin
      [], // target orgUser — NOT found
    ]);

    const ctx = makeCtx();
    await expect(
      orgMemberRoleChangeHandler(
        { targetUserId: "stranger", newRole: "Admin" },
        ctx,
      ),
    ).rejects.toThrow("Not found");
  });

  it("newRole does not exist in org → throws with descriptive message", async () => {
    mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // actor principal
      [{ roleName: "Owner" }], // actor PRA = Owner
      [{ id: "target-ou", role: "member" }], // target orgUser found
      [], // new role row NOT found
    ]);

    const ctx = makeCtx();
    await expect(
      orgMemberRoleChangeHandler(
        { targetUserId: "target", newRole: "Nonexistent" },
        ctx,
      ),
    ).rejects.toThrow("does not exist");
  });

  it("demoting last Owner → blocked", async () => {
    // The handler has two kinds of select calls:
    //  (a) chained with .limit()  — resolves via limit()
    //  (b) chained WITHOUT .limit() (allOwnerPras) — .where() must itself be thenable
    //
    // We build a custom mock that makes .where() a thenable Promise-like so
    // both usages work from the same mock setup.

    const callResults: unknown[][] = [
      [{ id: "actor-principal-id" }], // 1: actor principal (.limit)
      [{ roleName: "Owner" }], // 2: actor PRA (.limit via innerJoin)
      [{ id: "target-ou", role: "owner" }], // 3: target orgUser (.limit)
      [{ id: "admin-role-id", name: "Admin" }], // 4: new role row (.limit)
      [{ id: "owner-role-id" }], // 5: Owner role row (.limit)
      [{ id: "target-principal-id" }], // 6: target principal (.limit)
      [{ id: "target-owner-pra-id" }], // 7: target owner PRA (.limit)
      [{ id: "only-pra-row" }], // 8: allOwnerPras — NO .limit(), direct await
    ];
    let callCount = 0;

    mockTx.select = vi.fn().mockImplementation(() => {
      const idx = callCount++;
      const result = callResults[idx] ?? [];

      // Allow both `await chain.where()` and `await chain.where().limit(n)`.
      const limitOnWhere = vi.fn().mockResolvedValue(result);
      const whereWithLimit = vi.fn().mockReturnValue(
        Object.assign(Promise.resolve(result), {
          limit: limitOnWhere,
        }),
      );
      const innerJoin = vi.fn().mockReturnValue({ where: whereWithLimit });
      const from = vi
        .fn()
        .mockReturnValue({ where: whereWithLimit, innerJoin });
      return { from };
    });

    const ctx = makeCtx();
    await expect(
      orgMemberRoleChangeHandler(
        { targetUserId: "target", newRole: "Admin" },
        ctx,
      ),
    ).rejects.toThrow("Cannot demote the last org owner");
  });

  it("happy path → changes role, emits org.role_changed, returns changed:true", async () => {
    // All reads run inside withTenantDb on the same tx → continuous sequence:
    // 1-2 resolveActor, 3-7 main guards, 8 mutation principal lookup.
    mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // 1: actor principal
      [{ roleName: "Owner" }], // 2: actor PRA = Owner
      [{ id: "target-ou-id", role: "member" }], // 3: target orgUser (role=member)
      [{ id: "admin-role-id", name: "Admin" }], // 4: new role 'Admin' found
      // newRole !== OWNER_ROLE_NAME → last-owner guard runs:
      [{ id: "owner-role-id" }], // 5: Owner role row exists
      [{ id: "target-principal-id" }], // 6: target principal
      [], // 7: target does NOT hold Owner PRA → skip guard
      [{ id: "target-principal-id" }], // 8: mutation existing principal
    ]);

    const txUpdateWhere = vi.fn().mockResolvedValue([]);
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
    mockTx.update = vi.fn().mockReturnValue({ set: txUpdateSet });

    const onConflictDoNothing = vi.fn().mockResolvedValue([]);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    mockTx.insert = vi.fn().mockReturnValue({ values });

    const ctx = makeCtx();
    const result = await orgMemberRoleChangeHandler(
      { targetUserId: "target-user", newRole: "Admin" },
      ctx,
    );

    expect(result).toMatchObject({
      changed: true,
      targetUserId: "target-user",
      orgId: "org-abc",
      previousRole: "member",
      newRole: "Admin",
    });

    // Audit event emitted.
    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const [event] = mockEmitSecurityEvent.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(event.eventType).toBe("org.role_changed");
    expect(event.orgId).toBe("org-abc");
    expect(event.outcome).toBe("success");
    expect(event.capability).toBe("change_member_role");
  });
});
