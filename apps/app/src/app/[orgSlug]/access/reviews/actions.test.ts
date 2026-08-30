/**
 * actions.test.ts — unit tests for access review server actions.
 *
 * Covers:
 *   confirmMemberAccessAction:
 *     - validation: invalid targetUserId (not UUID) → validation_error
 *     - resolveOrg/assertOrgMember failure → forbidden
 *     - happy path → ok:true, emits access.member_access_confirmed
 *   revokeMemberAccessAction:
 *     - validation: invalid targetUserId (not UUID) → validation_error
 *     - self_action guard → ok:false code:self_action
 *     - assertSecurityManager failure → forbidden
 *     - delete returns 0 rows → not_found
 *     - happy path → ok:true, emits org.member_removed + access.review_completed
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockAssertSecurityManager,
  mockAssertOrgMember,
  mockEmitSecurityEvent,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    deleteReturning: { id: string }[];
  }
  const dbState: DbState = { deleteReturning: [{ id: "ou-1" }] };

  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockAssertSecurityManager: vi.fn(),
    mockAssertOrgMember: vi.fn(),
    mockEmitSecurityEvent: vi.fn(),
    mockRevalidatePath: vi.fn(),
    dbState,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  assertSecurityManager: mockAssertSecurityManager,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mockEmitSecurityEvent,
}));

/** Error shaped like the sentinel `notFound()` throws (digest carries the 404 fallback code). */
function authDenial(): Error {
  const e = new Error("NEXT_HTTP_ERROR_FALLBACK");
  (e as Error & { digest: string }).digest = "NEXT_HTTP_ERROR_FALLBACK;404";
  return e;
}
vi.mock("@oxagen/database", () => {
  const makeTx = () => ({
    delete: (_table: unknown) => ({
      where: (_w: unknown) => ({
        returning: (_cols: unknown) => Promise.resolve(dbState.deleteReturning),
      }),
    }),
  });
  return {
    withSystemDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    ),
    schema: {
      orgUsers: {
        orgId: "orgId_col",
        userId: "userId_col",
        id: "id_col",
      },
    },
  };
});

import { confirmMemberAccessAction, revokeMemberAccessAction } from "./actions";

// SESSION.user.id must be a valid UUID because the action validates targetUserId
// with z.string().uuid() BEFORE the self_action guard.
const ACTOR_UUID = "a0000000-0000-0000-0000-000000000000";
const SESSION = { user: { id: ACTOR_UUID } };
const ORG = { id: "org-1", slug: "acme" };
const VALID_TARGET_UUID = "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("confirmMemberAccessAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("returns validation_error for a non-UUID targetUserId", async () => {
    const res = await confirmMemberAccessAction({
      orgSlug: "acme",
      targetUserId: "not-a-uuid",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("validation_error");
  });

  it("returns forbidden when resolveOrg denies (notFound sentinel)", async () => {
    mockResolveOrg.mockRejectedValue(authDenial());
    const res = await confirmMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("forbidden");
  });

  it("returns forbidden when assertOrgMember denies (notFound sentinel)", async () => {
    mockAssertOrgMember.mockRejectedValue(authDenial());
    const res = await confirmMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("forbidden");
  });

  it("returns internal (NOT forbidden) when the auth gate hits a DB/infra error", async () => {
    mockAssertOrgMember.mockRejectedValue(new Error("connection refused"));
    const res = await confirmMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("internal");
  });

  it("returns ok:true and emits access.member_access_confirmed on success", async () => {
    const res = await confirmMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(res.ok).toBe(true);
    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("access.member_access_confirmed");
    expect(event.actorUserId).toBe(ACTOR_UUID);
    expect(event.orgId).toBe("org-1");
    expect(event.outcome).toBe("success");
  });

  it("calls revalidatePath for the reviews page on success", async () => {
    await confirmMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/access/reviews");
  });
});

describe("revokeMemberAccessAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.deleteReturning = [{ id: "ou-1" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockAssertSecurityManager.mockResolvedValue(undefined);
  });

  it("returns validation_error for a non-UUID targetUserId", async () => {
    const res = await revokeMemberAccessAction({
      orgSlug: "acme",
      targetUserId: "bad-id",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("validation_error");
  });

  it("returns self_action when targetUserId equals the session user id", async () => {
    const res = await revokeMemberAccessAction({
      orgSlug: "acme",
      targetUserId: SESSION.user.id,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("self_action");
    expect(mockAssertSecurityManager).not.toHaveBeenCalled();
  });

  it("returns forbidden when assertSecurityManager denies (notFound sentinel)", async () => {
    mockAssertSecurityManager.mockRejectedValue(authDenial());
    const res = await revokeMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("forbidden");
  });

  it("returns internal (NOT forbidden) when the auth gate hits a DB/infra error", async () => {
    mockAssertSecurityManager.mockRejectedValue(
      new Error("connection refused"),
    );
    const res = await revokeMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("internal");
  });

  it("returns not_found when delete returns 0 rows", async () => {
    dbState.deleteReturning = [];
    const res = await revokeMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("returns ok:true and emits both org.member_removed and access.review_completed", async () => {
    const res = await revokeMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(res.ok).toBe(true);
    expect(mockEmitSecurityEvent).toHaveBeenCalledTimes(2);
    const eventTypes = mockEmitSecurityEvent.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).eventType,
    );
    expect(eventTypes).toContain("org.member_removed");
    expect(eventTypes).toContain("access.review_completed");
  });

  it("calls revalidatePath for reviews and members pages on success", async () => {
    await revokeMemberAccessAction({
      orgSlug: "acme",
      targetUserId: VALID_TARGET_UUID,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/access/reviews");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members");
  });
});
