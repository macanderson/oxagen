/**
 * Unit tests for org.member.role.change handler.
 *
 * Mocks:
 *   - @oxagen/database          → db() + schema
 *   - @oxagen/database/security → makeSecurityEventInserter
 *   - @oxagen/telemetry         → recordSecurityEvent
 *   - drizzle-orm               → and, eq, isNull
 *
 * Scenarios (every refusal is a HandlerError asserted by code, never message):
 *   1. No authenticated principal → forbidden
 *   2. No orgId → forbidden
 *   3. Actor has insufficient role (Member) → forbidden
 *   4. Target not in org → not_found (IDOR guard)
 *   5. Requested role does not exist in org → not_found
 *   6. Demoting last owner → conflict
 *   7. Happy path → changes role, emits org.role_changed event, returns changed:true
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
const mockTx = {
  select: vi.fn(),
  // The owner count reads PEOPLE, not assignment rows — one principal holding
  // Owner through both duplicate role rows is two legal rows and one owner —
  // so it goes through `selectDistinct`. It builds exactly like `select`, and
  // the tests point both at the same fluent mock so the call sequence stays
  // continuous.
  selectDistinct: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    // The handler runs the actor role gate + all reads + writes inside a single
    // withOrgDb (one org-wide RLS-scoped transaction) so the authorization check and the
    // mutation are atomic (no TOCTOU). The mock routes to the same fluent tx mock
    // so the call sequence is continuous.
    withOrgDb: async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
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

function buildSelectMock(calls: unknown[][]) {
  let callCount = 0;
  return vi.fn().mockImplementation(() => {
    const result = calls[callCount] ?? [];
    callCount++;
    const limit = vi.fn().mockResolvedValue(result);
    // The role lookups order before limiting, so `.where()` has to offer
    // `.orderBy()` as well as `.limit()`, and `.orderBy()` has to land back on
    // the same `.limit()`. Without this the ordered reads resolve to undefined
    // and every role in the file reads as "does not exist in this org".
    //
    // `.where()` is ALSO awaited directly — the last-owner guard reads every
    // duplicate 'Owner' row rather than one — so it is a thenable as well as a
    // builder. Returning a plain object made such a read resolve to the
    // builder itself, and `.length` on it is `undefined`, which silently
    // skipped the guard it was meant to drive.
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi
      .fn()
      .mockReturnValue(
        Object.assign(Promise.resolve(result), { limit, orderBy }),
      );
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

  it("no authenticated principal → forbidden", async () => {
    const ctx = makeCtx({ userId: null, apiKeyId: null });
    await expectHandlerError(
      orgMemberRoleChangeHandler({ targetUserId: "t", newRole: "Admin" }, ctx),
      "forbidden",
      "unauthenticated",
    );
  });

  it("no orgId → forbidden", async () => {
    const ctx = makeCtx({ orgId: null as unknown as string });
    await expectHandlerError(
      orgMemberRoleChangeHandler({ targetUserId: "t", newRole: "Admin" }, ctx),
      "forbidden",
      "org_scope_required",
    );
  });

  it("actor has Member role → forbidden", async () => {
    mockTx.selectDistinct = mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // actor principal
      [{ roleName: "Member" }], // actor PRA = Member
    ]);

    const ctx = makeCtx();
    await expectHandlerError(
      orgMemberRoleChangeHandler({ targetUserId: "t", newRole: "Admin" }, ctx),
      "forbidden",
      "insufficient_role",
    );
  });

  it("target not a member → not_found (IDOR guard)", async () => {
    mockTx.selectDistinct = mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // actor principal
      [{ roleName: "Admin" }], // actor PRA = Admin
      [], // target orgUser — NOT found
    ]);

    const ctx = makeCtx();
    await expectHandlerError(
      orgMemberRoleChangeHandler(
        { targetUserId: "stranger", newRole: "Admin" },
        ctx,
      ),
      "not_found",
      "target_not_member",
    );
  });

  it("newRole does not exist in org → not_found", async () => {
    mockTx.selectDistinct = mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // actor principal
      [{ roleName: "Owner" }], // actor PRA = Owner
      [{ id: "target-ou", role: "member" }], // target orgUser found
      [], // new role row NOT found
    ]);

    const ctx = makeCtx();
    await expectHandlerError(
      orgMemberRoleChangeHandler(
        { targetUserId: "target", newRole: "Nonexistent" },
        ctx,
      ),
      "not_found",
      "role_not_found",
    );
  });

  it("demoting last Owner → conflict, nothing written", async () => {
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

      // Allow `await chain.where()`, `await chain.where().limit(n)` and
      // `await chain.where().orderBy(...).limit(n)` — the role lookups order
      // before limiting so that a duplicate role name resolves deterministically.
      const limitOnWhere = vi.fn().mockResolvedValue(result);
      const orderByOnWhere = vi.fn().mockReturnValue({ limit: limitOnWhere });
      const whereWithLimit = vi.fn().mockReturnValue(
        Object.assign(Promise.resolve(result), {
          limit: limitOnWhere,
          orderBy: orderByOnWhere,
        }),
      );
      const innerJoin = vi.fn().mockReturnValue({ where: whereWithLimit });
      const from = vi
        .fn()
        .mockReturnValue({ where: whereWithLimit, innerJoin });
      return { from };
    });
    // The owner count reads through `selectDistinct`; it shares this builder
    // so the numbered call sequence above stays continuous.
    mockTx.selectDistinct = mockTx.select;

    mockTx.update = vi.fn();
    mockTx.insert = vi.fn();

    const ctx = makeCtx();
    await expectHandlerError(
      orgMemberRoleChangeHandler(
        { targetUserId: "target", newRole: "Admin" },
        ctx,
      ),
      "conflict",
      "last_owner",
    );
    expect(mockTx.update).not.toHaveBeenCalled();
    expect(mockTx.insert).not.toHaveBeenCalled();
    expect(mockEmitSecurityEvent).not.toHaveBeenCalled();
  });

  // `iam.roles` is not unique on (org, scope_kind, name) and this org carries
  // two 'Owner' rows seeded in the same transaction. The resolve above takes
  // the OLDEST, deliberately — it is the row assignments were written against.
  // The guard cannot borrow that choice: an Owner granted against the NEWER
  // duplicate matches no oldest-row predicate, so reading one row made the sole
  // Owner look like a non-Owner, the guard never ran, and they were demoted out
  // of their own organisation.
  it("sees an Owner granted through a duplicate role row, and refuses to demote them", async () => {
    mockTx.selectDistinct = mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // 1: actor principal
      [{ roleName: "Owner" }], // 2: actor PRA = Owner
      [{ id: "target-ou-id", role: "owner" }], // 3: target orgUser
      [{ id: "admin-role-id", name: "Admin" }], // 4: new role 'Admin'
      // 5: BOTH 'Owner' rows, read unordered and unlimited.
      [{ id: "owner-role-old" }, { id: "owner-role-new" }],
      [{ id: "target-principal-id" }], // 6: target principal
      // 7: the target's Owner grant — written against the NEWER duplicate.
      [{ id: "target-owner-pra", roleId: "owner-role-new" }],
      // 8: distinct Owner PRINCIPALS. The target holds Owner through BOTH
      // duplicate role rows, which is two perfectly legal assignment rows and
      // exactly one person — counting rows read it as two owners and let the
      // guard pass, which demoted the only Owner the organisation has.
      [{ principalId: "target-principal-id" }],
    ]);
    mockTx.update = vi.fn();
    mockTx.insert = vi.fn();

    await expectHandlerError(
      orgMemberRoleChangeHandler(
        { targetUserId: "target", newRole: "Admin" },
        makeCtx(),
      ),
      "conflict",
      "last_owner",
    );
    expect(mockTx.update).not.toHaveBeenCalled();
    expect(mockTx.insert).not.toHaveBeenCalled();
  });

  it("happy path → changes role, emits org.role_changed, returns changed:true", async () => {
    // All reads run inside withOrgDb on the same tx → continuous sequence:
    // 1-2 resolveActor, 3-7 main guards, 8 mutation principal lookup.
    mockTx.selectDistinct = mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // 1: actor principal
      [{ roleName: "Owner" }], // 2: actor PRA = Owner
      [{ id: "target-ou-id", role: "member" }], // 3: target orgUser (role=member)
      [{ id: "admin-role-id", name: "Admin" }], // 4: new role 'Admin' found
      // newRole !== OWNER_ROLE_NAME → last-owner guard runs:
      [{ id: "owner-role-id" }], // 5: Owner role row exists
      [{ id: "target-principal-id" }], // 6: target principal
      [], // 7: target does NOT hold Owner PRA → skip guard
      [{ id: "target-principal-id" }], // 8: mutation existing principal
      [{ id: "new-pra-id" }], // 9: post-condition — the grant is live
    ]);

    const txUpdateWhere = vi.fn().mockResolvedValue([]);
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
    mockTx.update = vi.fn().mockReturnValue({ set: txUpdateSet });

    const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
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

  it("a member named by public id is resolved to their user id, after the actor gate", async () => {
    mockTx.selectDistinct = mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // 1: actor principal
      [{ roleName: "Owner" }], // 2: actor PRA = Owner
      [{ userId: "target-user-uuid" }], // 3: usr_… → users.id, joined to org_users
      [{ id: "target-ou-id", role: "member" }], // 4: target orgUser
      [{ id: "admin-role-id", name: "Admin" }], // 5: new role 'Admin' found
      [{ id: "owner-role-id" }], // 6: Owner role row exists
      [{ id: "target-principal-id" }], // 7: target principal
      [], // 8: target does NOT hold Owner PRA → skip guard
      [{ id: "target-principal-id" }], // 9: mutation existing principal
      [{ id: "new-pra-id" }], // 10: post-condition — the grant is live
    ]);

    const txUpdateWhere = vi.fn().mockResolvedValue([]);
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
    mockTx.update = vi.fn().mockReturnValue({ set: txUpdateSet });
    const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockTx.insert = vi.fn().mockReturnValue({ values });

    const result = await orgMemberRoleChangeHandler(
      { targetUserId: "usr_7k2m9q4x8r1t5v3w6y0z2a", newRole: "Admin" },
      makeCtx(),
    );

    // The answer names the target the caller named, not the uuid it resolved.
    expect(result).toMatchObject({
      changed: true,
      targetUserId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      newRole: "Admin",
    });
    expect(mockTx.insert).toHaveBeenCalledOnce();
  });

  it("a public id that names nobody in this org → not_found, nothing written", async () => {
    mockTx.selectDistinct = mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // 1: actor principal
      [{ roleName: "Owner" }], // 2: actor PRA = Owner
      [], // 3: the public id resolves to no member of this org
    ]);
    mockTx.update = vi.fn();
    mockTx.insert = vi.fn();

    await expectHandlerError(
      orgMemberRoleChangeHandler(
        { targetUserId: "usr_0000000000000000000000", newRole: "Admin" },
        makeCtx(),
      ),
      "not_found",
      "target_not_member",
    );
    expect(mockTx.update).not.toHaveBeenCalled();
    expect(mockTx.insert).not.toHaveBeenCalled();
  });

  // ── The self-lockout regression (2026-09-18) ───────────────────────────────
  // `pra_principal_role_org_null_workspace_uniq` is UNIQUE (principal_id,
  // role_id, org_id) WHERE workspace_id IS NULL, and carries `deleted_at`
  // neither in the key nor in the predicate. So the row the revocation step
  // soft-deletes still occupies the slot the grant step inserts into, and the
  // grant MUST resurrect it. `onConflictDoNothing` there discarded the grant
  // while the revocation committed, leaving the member with no org role — which
  // is how the sole Owner of a production organisation lost every grant by
  // re-applying the role they already held.
  it("re-granting the role the member already holds resurrects the assignment, never drops it", async () => {
    mockTx.selectDistinct = mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // 1: actor principal
      [{ roleName: "Owner" }], // 2: actor PRA = Owner
      [{ id: "target-ou-id", role: "owner" }], // 3: target orgUser, lowercase 'owner'
      [{ id: "owner-role-id", name: "Owner" }], // 4: new role 'Owner' resolves
      // newRole IS Owner → the last-owner guard is skipped entirely, which is
      // exactly why it could not catch this.
      [{ id: "target-principal-id" }], // 5: mutation existing principal
      [{ id: "resurrected-pra-id" }], // 6: post-condition — a live grant remains
    ]);

    const txUpdateWhere = vi.fn().mockResolvedValue([]);
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
    mockTx.update = vi.fn().mockReturnValue({ set: txUpdateSet });

    const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockTx.insert = vi.fn().mockReturnValue({ values });

    await orgMemberRoleChangeHandler(
      { targetUserId: "target-user", newRole: "Owner" },
      makeCtx(),
    );

    // The grant upserts rather than silently doing nothing on conflict...
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    // ...and what it writes on conflict is the un-deletion of the row the
    // revocation step just tombstoned.
    const [conflictArg] = onConflictDoUpdate.mock.calls[0] as [
      { set: Record<string, unknown> },
    ];
    expect(conflictArg.set).toMatchObject({
      deletedAt: null,
      deletedById: null,
    });
  });

  it("a role change that would leave the member with no org role refuses instead of committing", async () => {
    mockTx.selectDistinct = mockTx.select = buildSelectMock([
      [{ id: "actor-principal-id" }], // 1: actor principal
      [{ roleName: "Owner" }], // 2: actor PRA = Owner
      [{ id: "target-ou-id", role: "owner" }], // 3: target orgUser
      [{ id: "owner-role-id", name: "Owner" }], // 4: new role 'Owner' resolves
      [{ id: "target-principal-id" }], // 5: mutation existing principal
      [], // 6: post-condition — NO live grant survived
    ]);

    const txUpdateWhere = vi.fn().mockResolvedValue([]);
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
    mockTx.update = vi.fn().mockReturnValue({ set: txUpdateSet });
    const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockTx.insert = vi.fn().mockReturnValue({ values });

    const err = await orgMemberRoleChangeHandler(
      { targetUserId: "target-user", newRole: "Owner" },
      makeCtx(),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    // A bare `Error` would pass an `instanceof Error` assertion while reaching
    // every surface as an unclassified 500, which is the opposite of what this
    // refusal is for. The type and the code are what pin it.
    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({
      code: "conflict",
      reason: "role_change_left_no_role",
    });
    expect((err as Error).message).toContain("no organisation role");
    // Refused before the audit event, so nothing claims a change happened.
    expect(mockEmitSecurityEvent).not.toHaveBeenCalled();
  });
});
