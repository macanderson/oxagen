/**
 * Unit tests for org.member.remove handler.
 *
 * Mocks:
 *   - @oxagen/database          → db() + schema
 *   - @oxagen/database/security → makeSecurityEventInserter
 *   - @oxagen/telemetry         → recordSecurityEvent (fire-and-forget, tracked)
 *   - drizzle-orm               → and, eq, isNull, count
 *
 * Scenarios (every refusal is a HandlerError asserted by code, never message):
 *   1. No authenticated principal → forbidden
 *   2. No orgId → forbidden
 *   3. Actor has no principal or insufficient role → forbidden
 *   4. Target not in org → not_found (IDOR guard)
 *   5. Target is last org owner → conflict
 *   6. Happy path → removes membership, emits audit event, returns removed:true
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HandlerError, type CapabilityContext } from "@oxagen/oxagen";

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
    // The handler runs all reads + writes inside a single withSystemDb
    // transaction fenced on ctx.orgId; resolveActorPrincipalAndRole uses its
    // own. Both route to the same fluent tx mock so the call sequence is
    // continuous.
    //
    // withTenantDb is mocked inert on purpose. Under the org-only workspace
    // sentinel the app removes a member with, RLS narrows
    // iam.principal_role_assignments to its workspace_id IS NULL rows and
    // auth.api_keys and workspace.workspace_users to none at all — silently. A
    // regression to the tenant-scoped seam fails on `undefined` here rather
    // than leaving a removed member holding their workspace roles.
    withSystemDb: async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
      fn(mockTx),
    withTenantDb: () => undefined,
  };
});

const { orgMemberRemoveHandler } = await import("./org.member.remove");
const { schema } = await import("@oxagen/database");

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

/** Awaits a rejection and asserts it is a HandlerError with this code and reason. */
async function expectHandlerError(
  run: Promise<unknown>,
  code: HandlerError["code"],
  reason: string,
): Promise<void> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HandlerError);
  expect(err).toMatchObject({ code, reason });
}

/**
 * Chain builder for select().from().where()[.limit()] returning a resolved
 * array. `where()` is awaitable as well as chainable, because the workspace
 * sweep reads every workspace of the org without a limit.
 */
function selectChain(result: unknown[]) {
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi
    .fn()
    .mockImplementation(() =>
      Object.assign(Promise.resolve(result), { limit }),
    );
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ where, innerJoin });
  return { select: vi.fn().mockReturnValue({ from }), limit, where };
}

/**
 * A write terminator that is both awaitable and `.returning()`-able — the two
 * revocations report the rows they touched now, because an UPDATE that matches
 * nothing is not an error and that is exactly how the narrowing hid.
 */
function writeResult(rows: unknown[] = []) {
  return Object.assign(Promise.resolve(rows), {
    returning: vi.fn().mockResolvedValue(rows),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("orgMemberRemoveHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no authenticated principal → forbidden", async () => {
    const ctx = makeCtx({ userId: null, apiKeyId: null });
    await expectHandlerError(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
      "forbidden",
      "unauthenticated",
    );
  });

  it("no orgId → forbidden", async () => {
    const ctx = makeCtx({ orgId: null as unknown as string });
    await expectHandlerError(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
      "forbidden",
      "org_scope_required",
    );
  });

  it("actor has no principal (not IAM-provisioned) → forbidden", async () => {
    // select chain for resolveActorPrincipalAndRole — principal not found
    const sc = selectChain([]);
    mockTx.select = sc.select;

    const ctx = makeCtx();
    await expectHandlerError(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
      "forbidden",
      "insufficient_role",
    );
  });

  it("actor has Member role (not Owner/Admin) → forbidden", async () => {
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
    await expectHandlerError(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
      "forbidden",
      "insufficient_role",
    );
  });

  it("target not a member of the org → not_found (IDOR guard)", async () => {
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
    await expectHandlerError(
      orgMemberRemoveHandler({ targetUserId: "other-org-user" }, ctx),
      "not_found",
      "target_not_member",
    );
  });

  it("target is the last owner → conflict, nothing deleted", async () => {
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      const build = (result: unknown[]) => ({
        from: selectChain(result).select().from,
      });
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

    mockTx.delete = vi.fn();
    mockTx.update = vi.fn();

    const ctx = makeCtx();
    await expectHandlerError(
      orgMemberRemoveHandler({ targetUserId: "target-user" }, ctx),
      "conflict",
      "last_owner",
    );
    expect(mockTx.delete).not.toHaveBeenCalled();
    expect(mockTx.update).not.toHaveBeenCalled();
    expect(mockEmitSecurityEvent).not.toHaveBeenCalled();
  });

  it("happy path → removes member, emits audit event, returns removed:true", async () => {
    // All reads run inside withTenantDb on the same tx, so the call sequence is
    // continuous: 1-2 resolveActor, 3-7 main guards, 8 mutation principal lookup.
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      const build = (result: unknown[]) => ({
        from: selectChain(result).select().from,
      });
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

    const updateWhere = vi.fn().mockImplementation(() => writeResult());
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    mockTx.update = vi.fn().mockReturnValue({ set: updateSet });

    const deleteWhere = vi.fn().mockImplementation(() => writeResult());
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

    // The target's CLI session keys are soft-deleted with the membership.
    expect(mockTx.update).toHaveBeenCalledWith(schema.apiKeys);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: expect.any(Date),
        deletedByUserId: "actor-user-id",
      }),
    );
  });

  it("revokes role assignments at every scope and drops workspace memberships", async () => {
    // The removal the org-only workspace sentinel used to narrow. Step (b)
    // deliberately carries no workspace predicate — its intent is to revoke the
    // principal's roles at EVERY scope — and RLS put the predicate back, so the
    // UPDATE reached only the workspace_id IS NULL rows and said nothing. Step
    // (c)'s status: "deleted" does not compensate: fetch-authz resolves a
    // principal with no status filter and iam-provision reuses the same row, so
    // a re-invited member returns holding their old workspace roles.
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      const build = (result: unknown[]) => ({
        from: selectChain(result).select().from,
      });
      if (callCount === 1) return build([{ id: "actor-principal-id" }]);
      if (callCount === 2) return build([{ roleName: "Owner" }]);
      if (callCount === 3) return build([{ id: "target-ou", role: "member" }]);
      if (callCount === 4) return build([{ id: "owner-role-id" }]);
      if (callCount === 5) return build([{ n: 2 }]);
      if (callCount === 6) return build([{ id: "target-principal-id" }]);
      if (callCount === 7) return build([]);
      if (callCount === 8) return build([{ id: "target-principal-id" }]);
      // (e) the org's workspaces, the fence for workspace_users
      if (callCount === 9) return build([{ id: "ws-1" }, { id: "ws-2" }]);
      return build([]);
    });

    const revokedAssignments = [
      { id: "pra-org", workspaceId: null },
      { id: "pra-ws-1", workspaceId: "ws-1" },
      { id: "pra-ws-2", workspaceId: "ws-2" },
    ];
    const praReturning = vi.fn().mockResolvedValue(revokedAssignments);
    const keyReturning = vi.fn().mockResolvedValue([{ id: "key-1" }]);
    const updateSet = vi.fn();
    mockTx.update = vi.fn().mockImplementation((table: unknown) => ({
      set: updateSet.mockReturnValue({
        where: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve([]), {
            returning: table === schema.apiKeys ? keyReturning : praReturning,
          }),
        ),
      }),
    }));

    const wsuReturning = vi.fn().mockResolvedValue([{ id: "wsu-1" }]);
    const deletedTables: unknown[] = [];
    mockTx.delete = vi.fn().mockImplementation((table: unknown) => {
      deletedTables.push(table);
      return {
        where: vi
          .fn()
          .mockReturnValue(
            Object.assign(Promise.resolve([]), { returning: wsuReturning }),
          ),
      };
    });

    const result = await orgMemberRemoveHandler(
      { targetUserId: "target-user" },
      makeCtx(),
    );

    expect(result.removed).toBe(true);
    // The workspace-scoped assignments are in the revoked set, not only the
    // org-wide one.
    expect(praReturning).toHaveBeenCalled();
    // org_users AND workspace_users, in that order.
    expect(deletedTables).toEqual([schema.orgUsers, schema.workspaceUsers]);
    expect(wsuReturning).toHaveBeenCalled();
    // The CLI session keys are revoked for real rather than matching nothing.
    expect(keyReturning).toHaveBeenCalled();
  });

  it("skips the workspace sweep when the org has no workspaces", async () => {
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      const build = (result: unknown[]) => ({
        from: selectChain(result).select().from,
      });
      if (callCount === 1) return build([{ id: "actor-principal-id" }]);
      if (callCount === 2) return build([{ roleName: "Owner" }]);
      if (callCount === 3) return build([{ id: "target-ou", role: "member" }]);
      if (callCount === 4) return build([{ id: "owner-role-id" }]);
      if (callCount === 5) return build([{ n: 2 }]);
      if (callCount === 6) return build([{ id: "target-principal-id" }]);
      if (callCount === 7) return build([]);
      if (callCount === 8) return build([{ id: "target-principal-id" }]);
      return build([]); // no workspaces
    });
    mockTx.update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: () => writeResult() }),
    });
    const deletedTables: unknown[] = [];
    mockTx.delete = vi.fn().mockImplementation((table: unknown) => {
      deletedTables.push(table);
      return { where: () => writeResult() };
    });

    await orgMemberRemoveHandler({ targetUserId: "target-user" }, makeCtx());

    expect(deletedTables).toEqual([schema.orgUsers]);
  });

  it("a member named by public id is resolved to their user id, after the actor gate", async () => {
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      const build = (result: unknown[]) => ({
        from: selectChain(result).select().from,
      });
      if (callCount === 1) return build([{ id: "actor-principal-id" }]); // actor principal
      if (callCount === 2) return build([{ roleName: "Admin" }]); // actor PRA = Admin
      if (callCount === 3) return build([{ userId: "target-user-uuid" }]); // usr_… → users.id
      if (callCount === 4) return build([{ id: "target-ou", role: "member" }]); // target orgUser
      if (callCount === 5) return build([{ id: "owner-role-id" }]); // Owner role row
      if (callCount === 6) return build([{ n: 2 }]); // 2 owners — no lockout
      if (callCount === 7) return build([{ id: "target-principal-id" }]); // target principal
      if (callCount === 8) return build([]); // target holds no Owner PRA
      if (callCount === 9) return build([{ id: "target-principal-id" }]); // mutation principal
      return build([]);
    });

    const updateWhere = vi.fn().mockImplementation(() => writeResult());
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    mockTx.update = vi.fn().mockReturnValue({ set: updateSet });
    const deleteWhere = vi.fn().mockImplementation(() => writeResult());
    mockTx.delete = vi.fn().mockReturnValue({ where: deleteWhere });

    const result = await orgMemberRemoveHandler(
      { targetUserId: "usr_7k2m9q4x8r1t5v3w6y0z2a" },
      makeCtx(),
    );

    // The answer names the target the caller named, not the uuid it resolved.
    expect(result).toMatchObject({
      removed: true,
      targetUserId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
    });
    expect(mockTx.delete).toHaveBeenCalledOnce();
  });

  it("a public id that names nobody in this org → not_found, nothing deleted", async () => {
    let callCount = 0;
    mockTx.select = vi.fn().mockImplementation(() => {
      callCount++;
      const build = (result: unknown[]) => ({
        from: selectChain(result).select().from,
      });
      if (callCount === 1) return build([{ id: "actor-principal-id" }]);
      if (callCount === 2) return build([{ roleName: "Owner" }]);
      return build([]); // 3: the public id resolves to no member of this org
    });
    mockTx.delete = vi.fn();
    mockTx.update = vi.fn();

    await expectHandlerError(
      orgMemberRemoveHandler(
        { targetUserId: "usr_0000000000000000000000" },
        makeCtx(),
      ),
      "not_found",
      "target_not_member",
    );
    expect(mockTx.delete).not.toHaveBeenCalled();
    expect(mockTx.update).not.toHaveBeenCalled();
  });
});
