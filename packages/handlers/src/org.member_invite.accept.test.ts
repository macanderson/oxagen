/**
 * Unit tests for org.member.invite.accept handler.
 *
 * Mocks:
 *  - @oxagen/database → db() + schema
 *  - ./iam-provision  → provisionMemberPrincipal
 *
 * Scenarios:
 *  1. No authenticated userId → throws Unauthorized
 *  2. Invitation not found → throws
 *  3. Invitation not pending (already accepted) → throws
 *  4. Expired invitation → marks expired + throws
 *  5. Email mismatch → throws
 *  6. Happy path → creates org_users row + provisions principal + assigns role
 *  7. Happy path without matching role → still succeeds (logs warning only)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// ── iam-provision mock ───────────────────────────────────────────────────────

const mockProvisionMemberPrincipal = vi.fn().mockResolvedValue("prn-uuid-001");

vi.mock("./iam-provision", () => ({
  provisionMemberPrincipal: mockProvisionMemberPrincipal,
}));

// ── logger mock ──────────────────────────────────────────────────────────────
// Spy on the package logger so we can assert the mark-expired failure path logs.
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./logger", () => ({ logger: loggerMock }));

// ── drizzle-orm mock ─────────────────────────────────────────────────────────

// ── @oxagen/database mock ────────────────────────────────────────────────────

const mockUpdate = vi.fn();
const mockInsert = vi.fn();
const mockSelectFn = vi.fn();

const mockDb = {
  query: {
    invitations: { findFirst: vi.fn() },
  },
  select: mockSelectFn,
  update: mockUpdate,
  insert: mockInsert,
  transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    // Use the same mock db as the tx.
    return cb(mockDb);
  }),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => mockDb,
    // withSystemDb passthrough: the handler uses withSystemDb for all DB access
    // (invitation lookup, user lookup, expiry update, and the main tx). We
    // forward each call to the same mockDb so existing mock chains apply.
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
  };
});

const { orgMemberInviteAcceptHandler } = await import(
  "./org.member_invite.accept"
);

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, unknown> = {}): CapabilityContext {
  return {
    userId: "user-invitee",
    apiKeyId: null,
    orgId: "org-abc",
    workspaceId: "ws-abc",
    surface: "api",
    planTier: "build",
    ...overrides,
  } as CapabilityContext;
}

function makeInvitation(
  overrides: Partial<{
    id: string;
    publicId: string;
    orgId: string;
    email: string;
    role: string;
    status: string;
    expiresAt: Date | null;
  }> = {},
) {
  return {
    id: "inv-uuid-001",
    publicId: "inv_TESTACCEPT01",
    orgId: "org-abc",
    email: "alice@example.com",
    role: "Member",
    status: "pending",
    expiresAt: null,
    ...overrides,
  };
}

/**
 * The accept UPDATE is a compare-and-swap, so `.where()` is awaited directly by
 * the best-effort mark-expired write and chained into `.returning()` by the
 * claim. The thenable carries both. `claimedRows` is what the claim gets back:
 * one row means this transaction won the race, none means it lost.
 */
function makeUpdateChain(
  claimedRows: { id: string }[] = [{ id: "inv-uuid-001" }],
) {
  const setCalled = vi.fn().mockReturnThis();
  const whereCalled = vi.fn(() =>
    Object.assign(Promise.resolve(undefined), {
      returning: vi.fn().mockResolvedValue(claimedRows),
    }),
  );
  return { set: setCalled, where: whereCalled };
}

function makeInsertChain(returnRows: { publicId: string }[]) {
  const onConflictMock = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(returnRows),
  });
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: onConflictMock,
      returning: vi.fn().mockResolvedValue(returnRows),
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("orgMemberInviteAcceptHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no userId → throws Unauthorized", async () => {
    const ctx = makeCtx({ userId: null });
    await expect(
      orgMemberInviteAcceptHandler({ invitationPublicId: "inv_X" }, ctx),
    ).rejects.toThrow("Unauthorized");
  });

  it("invitation not found → throws", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(undefined);
    const ctx = makeCtx();
    await expect(
      orgMemberInviteAcceptHandler({ invitationPublicId: "inv_MISSING" }, ctx),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "invitation_not_found",
    });
  });

  it("invitation already accepted → throws", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(
      makeInvitation({ status: "accepted" }),
    );
    const ctx = makeCtx();
    await expect(
      orgMemberInviteAcceptHandler({ invitationPublicId: "inv_X" }, ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "invitation_closed" });
  });

  it("expired invitation → throws expired error", async () => {
    const pastDate = new Date(Date.now() - 1000);
    mockDb.query.invitations.findFirst.mockResolvedValue(
      makeInvitation({ expiresAt: pastDate }),
    );
    // Mark-expired update chain.
    mockUpdate.mockReturnValue(makeUpdateChain());
    const ctx = makeCtx();
    await expect(
      orgMemberInviteAcceptHandler({ invitationPublicId: "inv_EXPIRED" }, ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "invitation_expired" });
  });

  // The expiry read ran in an earlier transaction, so an Owner can resend the
  // invitation before the mark-expired write lands. A resend keeps the row
  // pending and moves expires_at forward. When the write matched by id alone,
  // it overwrote the renewed row with `expired` and undid the resend.
  it("mark-expired write matches only a row still pending and past expiry", async () => {
    const pastDate = new Date(Date.now() - 1000);
    mockDb.query.invitations.findFirst.mockResolvedValue(
      makeInvitation({ expiresAt: pastDate }),
    );
    const chain = makeUpdateChain();
    mockUpdate.mockReturnValue(chain);

    await expect(
      orgMemberInviteAcceptHandler(
        { invitationPublicId: "inv_EXPIRED" },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "invitation_expired" });

    expect(chain.where).toHaveBeenCalledTimes(1);
    const whereArg = (chain.where.mock.calls[0] as unknown[])[0] as SQL;
    const { sql: text, params } = new PgDialect().sqlToQuery(whereArg);
    expect(text).toContain('"invitations"."id" = $');
    expect(text).toContain('"invitations"."status" = $');
    expect(text).toContain('"invitations"."expires_at" < $');
    expect(params).toContain("inv-uuid-001");
    expect(params).toContain("pending");
  });

  it("expired invitation with failing mark-expired update → logs warning, still throws expired", async () => {
    const pastDate = new Date(Date.now() - 1000);
    mockDb.query.invitations.findFirst.mockResolvedValue(
      makeInvitation({ expiresAt: pastDate }),
    );
    // The best-effort "mark expired" update rejects (e.g. transient DB error).
    // This must not swallow silently — it should log and still throw expired.
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(new Error("db write failed")),
    });

    const ctx = makeCtx();
    await expect(
      orgMemberInviteAcceptHandler({ invitationPublicId: "inv_EXPIRED" }, ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "invitation_expired" });

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invitationPublicId: "inv_EXPIRED" }),
      expect.stringContaining("failed to mark expired invitation"),
    );
  });

  it("email mismatch → throws", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(makeInvitation());
    // User's email doesn't match invite email.
    mockSelectFn.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([{ email: "other@example.com" }]),
        }),
      }),
    });
    const ctx = makeCtx();
    await expect(
      orgMemberInviteAcceptHandler({ invitationPublicId: "inv_X" }, ctx),
    ).rejects.toMatchObject({ code: "forbidden", reason: "wrong_email" });
  });

  // Witness for the revoke/accept race. The pending check runs in an earlier
  // transaction, so an Owner can revoke between that check and this write. The
  // claim re-asserts `status = 'pending'`: a revoke that already committed
  // leaves no pending row, the claim updates nothing, and the accept must
  // abort before it provisions anything. Without the compare-and-swap the
  // UPDATE matched by id alone, overwrote `revoked` with `accepted`, and the
  // revoked invitee got a membership row and an IAM principal.
  it("revoked between the check and the write → conflicts, provisions nothing", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(makeInvitation());
    mockSelectFn.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([{ email: "alice@example.com" }]),
        }),
      }),
    }));
    // The revoke committed first, so the claim matches no pending row.
    mockUpdate.mockReturnValue(makeUpdateChain([]));
    mockInsert.mockImplementation(() =>
      makeInsertChain([{ publicId: "oru_SHOULD_NOT_EXIST" }]),
    );

    const ctx = makeCtx();
    await expect(
      orgMemberInviteAcceptHandler(
        { invitationPublicId: "inv_TESTACCEPT01" },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "invitation_closed",
    });

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockProvisionMemberPrincipal).not.toHaveBeenCalled();
  });

  it("happy path → creates membership, provisions principal, assigns role", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(makeInvitation());

    // User email lookup (select from users).
    let selectCallIdx = 0;
    mockSelectFn.mockImplementation(() => {
      selectCallIdx++;
      if (selectCallIdx === 1) {
        // users email lookup
        return {
          from: () => ({
            where: () => ({
              limit: vi
                .fn()
                .mockResolvedValue([{ email: "alice@example.com" }]),
            }),
          }),
        };
      }
      // roles lookup
      return {
        from: () => ({
          where: () => ({
            limit: vi.fn().mockResolvedValue([{ id: "role-uuid-member" }]),
          }),
        }),
      };
    });

    // update for accepting invite.
    mockUpdate.mockReturnValue(makeUpdateChain());

    // insert org_users.
    const orgUserInsert = makeInsertChain([{ publicId: "oru_NEWMEMBER" }]);
    // insert principalRoleAssignment.
    const praInsert = makeInsertChain([]);
    let insertCallIdx = 0;
    mockInsert.mockImplementation(() => {
      insertCallIdx++;
      return insertCallIdx === 1 ? orgUserInsert : praInsert;
    });

    const ctx = makeCtx();
    const result = await orgMemberInviteAcceptHandler(
      { invitationPublicId: "inv_TESTACCEPT01" },
      ctx,
    );

    expect(result).toMatchObject({
      orgId: "org-abc",
      role: "Member",
    });
    expect(typeof result.joinedAt).toBe("string");
    expect(mockProvisionMemberPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-abc", userId: "user-invitee" }),
    );
  });

  it("role not found in DB → still succeeds (no PRA insert)", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(makeInvitation());

    let selectCallIdx = 0;
    mockSelectFn.mockImplementation(() => {
      selectCallIdx++;
      if (selectCallIdx === 1) {
        return {
          from: () => ({
            where: () => ({
              limit: vi
                .fn()
                .mockResolvedValue([{ email: "alice@example.com" }]),
            }),
          }),
        };
      }
      // roles lookup returns empty
      return {
        from: () => ({
          where: () => ({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      };
    });

    mockUpdate.mockReturnValue(makeUpdateChain());
    const orgUserInsert = makeInsertChain([{ publicId: "oru_MEMBER2" }]);
    mockInsert.mockReturnValue(orgUserInsert);

    const ctx = makeCtx();
    const result = await orgMemberInviteAcceptHandler(
      { invitationPublicId: "inv_TESTACCEPT01" },
      ctx,
    );
    expect(result.orgId).toBe("org-abc");
  });
});
