/**
 * Unit tests for org.member.remove handler.
 *
 * Mocks:
 *   - @oxagen/database          → db() + schema
 *   - @oxagen/database/security → makeSecurityEventInserter
 *   - @oxagen/telemetry         → recordSecurityEvent (fire-and-forget, tracked)
 *   - drizzle-orm               → and, eq, isNull, count
 *
 * Scenarios:
 *   1. No authenticated principal → throws Unauthorized
 *   2. No orgId → throws Forbidden
 *   3. Actor has no principal or insufficient role → throws Forbidden
 *   4. Target not in org → throws Not found (IDOR guard)
 *   5. Target is last org owner → blocked
 *   6. Happy path → removes membership, emits audit event, returns removed:true
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
// We build a fluent mock of the Drizzle query builder for:
//   select().from().where().limit()
//   select().from().innerJoin().where().limit()
//   select().from().where()  (count queries without limit)
//   update().set().where()
//   delete().where()
//   insert().values().onConflictDoNothing()
//   transaction()

const mockTx = {
  select: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  insert: vi.fn(),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    // The handler runs all reads + writes inside a single withTenantDb (one
    // RLS-scoped transaction); resolveActorPrincipalAndRole uses its own. Both
    // route to the same fluent tx mock so the call sequence is continuous.
    withTenantDb: async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
      fn(mockTx),
  };
});

const { orgMemberRemoveHandler } = await import("./org.member.remove");

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
    requestId: "req-123",
    messageId: null,
    ...overrides,
  } as CapabilityContext;
}

/** Chain builder for select().from().where().limit() returning a resolved array. */
function selectChain(result: unknown[]) {
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ limit });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ where, innerJoin });
  return { select: vi.fn().mockReturnValue({ from }), limit, where };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("orgMemberRemoveHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no authenticated principal → throws Unauthorized", async () => {
    const ctx = makeCtx({ userId: null, apiKeyId: null });
    await expect(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
    ).rejects.toThrow("Unauthorized");
  });

  it("no orgId → throws Forbidden", async () => {
    const ctx = makeCtx({ orgId: null as unknown as string });
    await expect(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
    ).rejects.toThrow("Forbidden");
  });

  it("actor has no principal (not IAM-provisioned) → throws Forbidden", async () => {
    // select chain for resolveActorPrincipalAndRole — principal not found
    const sc = selectChain([]);
    mockTx.select = sc.select;

    const ctx = makeCtx();
    await expect(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
    ).rejects.toThrow("Forbidden");
  });

  it("actor has Member role (not Owner/Admin) → throws Forbidden", async () => {
    // Call 1: principal found for actor
    // Call 2: PRA → Member role
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // actor principal
        const limit = vi.fn().mockResolvedValue([{ id: "actor-principal-id" }]);
        const where = vi.fn().mockReturnValue({ limit });
        const from = vi.fn().mockReturnValue({ where });
        return { from };
      }
      // actor PRA → Member
      const limit = vi.fn().mockResolvedValue([{ roleName: "Member" }]);
      const where = vi.fn().mockReturnValue({ limit });
      const innerJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ where, innerJoin });
      return { from };
    });

    const ctx = makeCtx();
    await expect(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
    ).rejects.toThrow("Forbidden");
  });

  it("target not a member of the org → throws Not found (IDOR guard)", async () => {
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      const buildChain = (result: unknown[]) => {
        const limit = vi.fn().mockResolvedValue(result);
        const where = vi.fn().mockReturnValue({ limit });
        const innerJoin = vi.fn().mockReturnValue({ where });
        const from = vi.fn().mockReturnValue({ where, innerJoin });
        return { from };
      };
      if (callCount === 1) return buildChain([{ id: "actor-principal-id" }]); // actor principal
      if (callCount === 2) return buildChain([{ roleName: "Owner" }]); // actor PRA
      if (callCount === 3) return buildChain([]); // target orgUser — NOT found
      return buildChain([]);
    });

    const ctx = makeCtx();
    await expect(
      orgMemberRemoveHandler({ targetUserId: "other-org-user" }, ctx),
    ).rejects.toThrow("Not found");
  });

  it("target is the last owner → throws with lockout message", async () => {
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      const build = (result: unknown[]) => {
        const limit = vi.fn().mockResolvedValue(result);
        const where = vi.fn().mockReturnValue({ limit });
        const innerJoin = vi.fn().mockReturnValue({ where });
        const from = vi.fn().mockReturnValue({ where, innerJoin });
        return { from };
      };
      if (callCount === 1) return build([{ id: "actor-principal-id" }]); // actor principal
      if (callCount === 2) return build([{ roleName: "Owner" }]); // actor PRA = Owner
      if (callCount === 3) return build([{ id: "target-ou", role: "owner" }]); // target orgUser found
      if (callCount === 4) return build([{ id: "owner-role-id" }]); // Owner role exists
      // ownerCountResult — count query, return via limit
      if (callCount === 5) return build([{ n: 1 }]); // only 1 owner
      if (callCount === 6) return build([{ id: "target-principal-id" }]); // target principal
      if (callCount === 7) return build([{ id: "target-pra-id" }]); // target IS an owner
      return build([]);
    });

    const ctx = makeCtx();
    await expect(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
    ).rejects.toThrow("Cannot remove the last org owner");
  });

  it("happy path → removes member, emits audit event, returns removed:true", async () => {
    // All reads run inside withTenantDb on the same tx, so the call sequence is
    // continuous: 1-2 resolveActor, 3-7 main guards, 8 mutation principal lookup.
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      const build = (result: unknown[]) => {
        const limit = vi.fn().mockResolvedValue(result);
        const where = vi.fn().mockReturnValue({ limit });
        const innerJoin = vi.fn().mockReturnValue({ where });
        const from = vi.fn().mockReturnValue({ where, innerJoin });
        return { from };
      };
      if (callCount === 1) return build([{ id: "actor-principal-id" }]); // actor principal
      if (callCount === 2) return build([{ roleName: "Admin" }]); // actor PRA = Admin
      if (callCount === 3) return build([{ id: "target-ou", role: "member" }]); // target orgUser found
      if (callCount === 4) return build([{ id: "owner-role-id" }]); // Owner role row
      if (callCount === 5) return build([{ n: 2 }]); // 2 owners — no lockout
      if (callCount === 6) return build([{ id: "target-principal-id" }]); // target principal (last owner check)
      if (callCount === 7) return build([]); // target has no Owner PRA → no lockout
      if (callCount === 8) return build([{ id: "target-principal-id" }]); // mutation: existing principal
      return build([]);
    });

    const updateWhere = vi.fn().mockResolvedValue([]);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    mockTx.update = vi.fn().mockReturnValue({ set: updateSet });

    const deleteWhere = vi.fn().mockResolvedValue([]);
    mockTx.delete = vi.fn().mockReturnValue({ where: deleteWhere });

    const ctx = makeCtx();
    const result = await orgMemberRemoveHandler(
      { targetUserId: "target-user" },
      ctx,
    );

    expect(result).toMatchObject({
      removed: true,
      targetUserId: "target-user",
      orgId: "org-abc",
    });

    // Audit event must have been emitted.
    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const [event] = mockEmitSecurityEvent.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(event.eventType).toBe("org.member_removed");
    expect(event.orgId).toBe("org-abc");
    expect(event.outcome).toBe("success");
    expect(event.capability).toBe("remove_org_member");
  });
});
