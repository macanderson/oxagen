/**
 * actions.test.ts — unit tests for org-level member server actions.
 *
 * Covers:
 *   inviteMemberAction:
 *     - validation: missing email, invalid role enum
 *     - seat limit reached → {ok:false, code:"seat_limit_reached"}
 *     - duplicate pending invitation (unique constraint) → {ok:false, code:"already_invited"}
 *     - happy path → {ok:true}
 *   declineInvitationAction:
 *     - no matching row (not found or already resolved) → {ok:false, error}
 *     - happy path → {ok:true}
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/database, @oxagen/tenancy,
 * @oxagen/billing, @oxagen/handlers/logger, next/cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockAssertSeatAvailable,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    insertError: Error | null;
    updateReturning: { id: string }[];
  }
  const dbState: DbState = {
    insertError: null,
    updateReturning: [{ id: "inv-1" }],
  };

  const mockTx = {
    insert: () => ({
      values: () => {
        if (dbState.insertError) throw dbState.insertError;
        return Promise.resolve(undefined);
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(dbState.updateReturning),
        }),
      }),
    }),
  };

  const mockWithTenantDb = vi.fn((fn: (tx: typeof mockTx) => unknown) => fn(mockTx));
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) => fn());

  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockRunInTenantScope,
    mockWithTenantDb,
    mockAssertSeatAvailable: vi.fn(),
    mockRevalidatePath: vi.fn(),
    dbState,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({ resolveOrg: mockResolveOrg }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", () => ({
  withTenantDb: mockWithTenantDb,
  schema: {
    invitations: "invitations_sentinel",
  },
}));
vi.mock("@oxagen/billing", () => ({
  assertSeatAvailable: mockAssertSeatAvailable,
  isSeatLimitError: (err: unknown) =>
    typeof err === "object" && err !== null && (err as { code?: string }).code === "seat_limit_reached",
  SeatLimitError: class SeatLimitError extends Error {
    readonly code = "seat_limit_reached" as const;
    constructor() {
      super("Seat limit reached");
    }
  },
}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  maskEmail: (e: string) => e,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: vi.fn(),
}));

import { inviteMemberAction, declineInvitationAction } from "./actions";

const ORG = { id: "org-1", slug: "acme" };
const SESSION = { user: { id: "user-1" } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inviteMemberAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.insertError = null;
    dbState.updateReturning = [{ id: "inv-1" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockAssertSeatAvailable.mockResolvedValue(undefined);
  });

  it("returns validation_error for an invalid email", async () => {
    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "not-an-email",
      role: "member",
    });
    expect(res).toMatchObject({ ok: false, code: "validation_error" });
  });

  it("returns validation_error for an unknown role", async () => {
    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "user@example.com",
      // @ts-expect-error — intentional bad role for test
      role: "superadmin",
    });
    expect(res).toMatchObject({ ok: false, code: "validation_error" });
  });

  it("returns seat_limit_reached when assertSeatAvailable throws SeatLimitError", async () => {
    const err = new Error("Seat limit reached");
    (err as { code?: string }).code = "seat_limit_reached";
    mockAssertSeatAvailable.mockRejectedValue(err);

    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "user@example.com",
      role: "member",
    });
    expect(res).toMatchObject({ ok: false, code: "seat_limit_reached" });
  });

  it("returns already_invited when DB throws a unique constraint violation", async () => {
    dbState.insertError = new Error("duplicate key value violates unique constraint invitations_org_email_pending_idx");

    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "user@example.com",
      role: "member",
    });
    expect(res).toMatchObject({ ok: false, code: "already_invited" });
  });

  it("returns {ok:true} on a successful invitation", async () => {
    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "newmember@example.com",
      role: "admin",
    });
    expect(res).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members");
  });
});

describe("declineInvitationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.insertError = null;
    dbState.updateReturning = [{ id: "inv-1" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
  });

  it("returns {ok:true} when the invitation exists and is updated", async () => {
    const res = await declineInvitationAction({
      orgSlug: "acme",
      invitationPublicId: "inv_01",
    });
    expect(res).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members");
  });

  it("returns {ok:false, error} when no matching pending invitation is found", async () => {
    dbState.updateReturning = [];

    const res = await declineInvitationAction({
      orgSlug: "acme",
      invitationPublicId: "inv_not_found",
    });
    expect(res).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
