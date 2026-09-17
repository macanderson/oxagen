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
 *     - non-owner/admin caller → {ok:false, error}, no revalidation
 *     - no matching row (not found or already resolved) → {ok:false, error}
 *     - happy path → {ok:true}
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/database, @oxagen/tenancy,
 * @oxagen/billing, @oxagen/notifications, @oxagen/config/env,
 * @oxagen/handlers/logger, next/cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockGetOrgRole,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockAssertSeatAvailable,
  mockRevalidatePath,
  mockSendEmail,
  mockInvitationEmailTemplate,
  mockLoadEnv,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    insertError: Error | null;
    insertReturning: { publicId: string }[];
    updateReturning: { id: string }[];
  }
  const dbState: DbState = {
    insertError: null,
    insertReturning: [{ publicId: "invi_test123" }],
    updateReturning: [{ id: "inv-1" }],
  };

  const mockTx = {
    insert: () => ({
      values: () => ({
        returning: () => {
          if (dbState.insertError) throw dbState.insertError;
          return Promise.resolve(dbState.insertReturning);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(dbState.updateReturning),
        }),
      }),
    }),
  };

  const mockWithTenantDb = vi.fn((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  );
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
  );

  // Passthrough template: build subject/text/html that embed the inviteUrl so
  // tests can assert the URL (and thus the publicId) is wired through.
  const mockInvitationEmailTemplate = vi.fn(
    (i: {
      inviteUrl: string;
      inviterName: string;
      orgName: string;
      role: string;
      email: string;
    }) => ({
      subject: `You've been invited to join ${i.orgName} on Oxagen`,
      text: `${i.inviterName} invited ${i.email} — accept: ${i.inviteUrl}`,
      html: `<a href="${i.inviteUrl}">Accept invitation</a>`,
    }),
  );

  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockGetOrgRole: vi.fn(),
    mockRunInTenantScope,
    mockWithTenantDb,
    mockAssertSeatAvailable: vi.fn(),
    mockRevalidatePath: vi.fn(),
    mockSendEmail: vi.fn(),
    mockInvitationEmailTemplate,
    mockLoadEnv: vi.fn(() => ({
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
    })),
    dbState,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: mockGetOrgRole,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mockWithTenantDb,
  };
});
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    assertSeatAvailable: mockAssertSeatAvailable,
    isSeatLimitError: (err: unknown) =>
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "seat_limit_reached",
    SeatLimitError: class SeatLimitError extends Error {
      readonly code = "seat_limit_reached" as const;
      constructor() {
        super("Seat limit reached");
      }
    },
  };
});
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  maskEmail: (e: string) => e,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: vi.fn(),
}));
vi.mock("@oxagen/notifications", () => ({
  sendEmail: mockSendEmail,
  invitationEmailTemplate: mockInvitationEmailTemplate,
}));
vi.mock("@oxagen/config/env", () => ({
  // inviteMemberAction now uses requireEnv(["NEXT_PUBLIC_APP_URL"]) (scoped) —
  // not loadEnv. Both resolve to the same fixture so the invite-email path works.
  requireEnv: mockLoadEnv,
  loadEnv: mockLoadEnv,
}));

import { inviteMemberAction, declineInvitationAction } from "./actions";

const ORG = { id: "org-1", name: "Acme Inc", slug: "acme" };
const SESSION = {
  user: { id: "user-1", name: "Alice Inviter", email: "alice@example.com" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inviteMemberAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.insertError = null;
    dbState.insertReturning = [{ publicId: "invi_test123" }];
    dbState.updateReturning = [{ id: "inv-1" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    // Default caller is an owner so existing happy-path invites (incl. admin
    // role) clear the authorization gate.
    mockGetOrgRole.mockResolvedValue("owner");
    mockAssertSeatAvailable.mockResolvedValue(undefined);
    mockSendEmail.mockResolvedValue({
      id: "msg-1",
      accepted: ["newmember@example.com"],
    });
  });

  it("returns forbidden when the caller is not a member of the org", async () => {
    mockGetOrgRole.mockResolvedValue(null);
    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "newmember@example.com",
      role: "member",
    });
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(mockWithTenantDb).not.toHaveBeenCalled();
  });

  it("returns forbidden when a plain member tries to invite", async () => {
    mockGetOrgRole.mockResolvedValue("member");
    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "newmember@example.com",
      role: "member",
    });
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(mockWithTenantDb).not.toHaveBeenCalled();
  });

  it("forbids an admin from granting the owner role (privilege escalation)", async () => {
    mockGetOrgRole.mockResolvedValue("admin");
    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "newmember@example.com",
      role: "owner",
    });
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(mockWithTenantDb).not.toHaveBeenCalled();
  });

  it("forbids an admin from granting the admin role", async () => {
    mockGetOrgRole.mockResolvedValue("admin");
    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "newmember@example.com",
      role: "admin",
    });
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("allows an admin to invite a plain member", async () => {
    mockGetOrgRole.mockResolvedValue("admin");
    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "newmember@example.com",
      role: "member",
    });
    expect(res).toEqual({ ok: true });
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
    // Verbatim Postgres text for the partial unique index, which is named "n".
    dbState.insertError = new Error(
      'duplicate key value violates unique constraint "n"',
    );

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
    // Revalidates BOTH /members (People tab) and /members/pending (Invited
    // tab) — this action is also called from the Invited tab's "Resend"
    // button, a different route than /members.
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members/pending");
  });

  it("sends the invitation email once, addressed to the invitee with the invite URL", async () => {
    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "newmember@example.com",
      role: "admin",
    });
    expect(res).toEqual({ ok: true });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const payload = mockSendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      text: string;
      html: string;
    };
    expect(payload.to).toBe("newmember@example.com");
    // The publicId from the insert must be threaded into the invite URL.
    expect(payload.subject).toContain("Acme Inc");
    expect(payload.text).toContain("invi_test123");
    expect(payload.html).toContain("invi_test123");
    expect(payload.text).toContain(
      "https://app.example.com/acme/members/accept?invitation=invi_test123",
    );

    // The template receives the org name, role, and invitee email.
    expect(mockInvitationEmailTemplate).toHaveBeenCalledTimes(1);
    expect(mockInvitationEmailTemplate.mock.calls[0]![0]).toMatchObject({
      orgName: "Acme Inc",
      role: "admin",
      email: "newmember@example.com",
      inviterName: "Alice Inviter",
    });
  });

  it("still returns {ok:true} when sendEmail rejects (email is non-fatal)", async () => {
    mockSendEmail.mockRejectedValue(new Error("SMTP not configured"));

    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "newmember@example.com",
      role: "member",
    });

    expect(res).toEqual({ ok: true });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members/pending");
  });

  it("falls back to the inviter's email for inviterName when session.user.name is null", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", name: null, email: "alice@example.com" },
    });

    const res = await inviteMemberAction({
      orgSlug: "acme",
      email: "newmember@example.com",
      role: "member",
    });

    expect(res).toEqual({ ok: true });
    expect(mockInvitationEmailTemplate).toHaveBeenCalledTimes(1);
    expect(mockInvitationEmailTemplate.mock.calls[0]![0]).toMatchObject({
      inviterName: "alice@example.com",
    });
  });
});

describe("declineInvitationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.insertError = null;
    dbState.updateReturning = [{ id: "inv-1" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    // Revoking is owner/admin-only, same gate as inviting.
    mockGetOrgRole.mockResolvedValue("owner");
  });

  it("returns {ok:false} when the caller is not an owner or admin", async () => {
    mockGetOrgRole.mockResolvedValue("member");

    const res = await declineInvitationAction({
      orgSlug: "acme",
      invitationPublicId: "inv_01",
    });
    expect(res).toMatchObject({ ok: false, error: expect.any(String) });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns {ok:true} when the invitation exists and is updated", async () => {
    const res = await declineInvitationAction({
      orgSlug: "acme",
      invitationPublicId: "inv_01",
    });
    expect(res).toEqual({ ok: true });
    // Revalidates BOTH /members and /members/pending — this action is also
    // called from the Invited tab's own "Revoke" button (a different route).
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members/pending");
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
