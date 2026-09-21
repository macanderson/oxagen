import { describe, expect, it, vi, beforeEach } from "vitest";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  findFirst: vi.fn(),
  sendEmail: vi.fn().mockResolvedValue(undefined),
  /** The organization roles the caller holds; the gate admits Owner or Admin. */
  callerOrgRoles: ["Owner"] as string[],
}));

// Default: insert succeeds and returns a row.
const DEFAULT_ROW = {
  publicId: "invi_TEST001",
  status: "pending",
  expiresAt: new Date("2024-07-15T00:00:00.000Z"),
};

mocks.insertReturning.mockResolvedValue([DEFAULT_ROW]);
mocks.findFirst.mockResolvedValue(null);

// The organization-role gate, stubbed so the suite decides who is calling
// without a database. The handler writes an organization invitation carrying
// an organization role, so only an org Owner or Admin may issue one.
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async (
    actor: { userId: string | null },
    required: { org: string[] },
  ) => {
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    const match = mocks.callerOrgRoles.find((r) => required.org.includes(r));
    if (!match)
      throw new HandlerError({
        code: "forbidden",
        reason: "role_not_permitted",
      });
    return match;
  },
}));

vi.mock("@oxagen/notifications", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/notifications")>();
  return { ...real, sendEmail: mocks.sendEmail };
});

vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({
              returning: mocks.insertReturning,
            }),
          }),
        }),
        query: {
          invitations: { findFirst: mocks.findFirst },
          organizations: { findFirst: () => ({ name: "Acme" }) },
          users: { findFirst: () => ({ displayName: "Jane" }) },
        },
      }),
  };
  return {
    ...dbMock,
    withOrgDb: dbMock.withTenantDb,
    withSystemDb: dbMock.withTenantDb,
  };
});

import { workspaceInviteSendHandler } from "./workspace.invite.send";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workspaceInviteSendHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertReturning.mockResolvedValue([DEFAULT_ROW]);
    mocks.findFirst.mockResolvedValue(null);
    mocks.callerOrgRoles = ["Owner"];
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      workspaceInviteSendHandler(
        { email: "alice@example.com", role: "member" },
        anonCtx,
      ),
    ).rejects.toThrow("workspace.invite.send requires an authenticated user");
  });

  // A member who is neither Owner nor Admin reaching the capability on any
  // surface could otherwise invite an account as Owner and take the
  // organization over: the contract's defaultRoles do not gate the call on
  // their own, because check-iam fast-paths a non-enterprise human principal.
  it.each(["member", "admin", "owner"] as const)(
    "refuses a Member inviting with role %s, and writes nothing",
    async (role) => {
      mocks.callerOrgRoles = ["Member"];
      const err = await workspaceInviteSendHandler(
        { email: "mallory@example.com", role },
        CTX,
      ).catch((e: unknown) => e);
      expect(isHandlerError(err) && err.code).toBe("forbidden");
      expect(mocks.insertReturning).not.toHaveBeenCalled();
    },
  );

  it("admits an org Admin", async () => {
    mocks.callerOrgRoles = ["Admin"];
    await expect(
      workspaceInviteSendHandler(
        { email: "alice@example.com", role: "member" },
        CTX,
      ),
    ).resolves.toMatchObject({ status: "pending" });
  });

  // ── happy path: new invite ────────────────────────────────────────────────

  it("returns id, status, and expires_at for a new invitation", async () => {
    const result = await workspaceInviteSendHandler(
      { email: "alice@example.com", role: "member" },
      CTX,
    );
    expect(result.id).toBe("invi_TEST001");
    expect(result.status).toBe("pending");
    expect(result.expires_at).toBe("2024-07-15T00:00:00.000Z");
  });

  it("calls insert once for a new invite", async () => {
    await workspaceInviteSendHandler(
      { email: "alice@example.com", role: "admin" },
      CTX,
    );
    expect(mocks.insertReturning).toHaveBeenCalledTimes(1);
  });

  // ── conflict: existing pending invite ────────────────────────────────────

  it("falls back to existing pending invite on insert conflict (no rows returned)", async () => {
    // Simulate onConflictDoNothing returning no rows (duplicate pending exists)
    mocks.insertReturning.mockResolvedValueOnce([]);
    mocks.findFirst.mockResolvedValueOnce({
      publicId: "invi_EXISTING",
      status: "pending",
      expiresAt: new Date("2024-08-01T00:00:00.000Z"),
    });

    const result = await workspaceInviteSendHandler(
      { email: "alice@example.com", role: "member" },
      CTX,
    );

    expect(result.id).toBe("invi_EXISTING");
    expect(result.status).toBe("pending");
    expect(result.expires_at).toBe("2024-08-01T00:00:00.000Z");
  });

  it("throws when conflict + existing row lookup also returns nothing", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    mocks.findFirst.mockResolvedValueOnce(undefined);

    await expect(
      workspaceInviteSendHandler(
        { email: "alice@example.com", role: "member" },
        CTX,
      ),
    ).rejects.toThrow(
      "conflict on insert but no existing pending invite found",
    );
  });

  // ── expires_at fallback ───────────────────────────────────────────────────

  it("falls back to computed expiresAt when row.expiresAt is null", async () => {
    mocks.insertReturning.mockResolvedValueOnce([
      { publicId: "invi_NOEXPIRY", status: "pending", expiresAt: null },
    ]);
    const before = Date.now();
    const result = await workspaceInviteSendHandler(
      { email: "bob@example.com", role: "owner" },
      CTX,
    );
    const resultTime = new Date(result.expires_at).getTime();
    // Should be roughly 7 days from now
    expect(resultTime).toBeGreaterThan(before + 6 * 864e5);
    expect(resultTime).toBeLessThan(before + 8 * 864e5);
  });
});

describe("invitation note delivery", () => {
  it.each([false, true])(
    "sends the note with an existing invite: %s",
    async (existing) => {
      mocks.callerOrgRoles = ["Owner"];
      mocks.sendEmail.mockClear();
      mocks.insertReturning.mockResolvedValueOnce(
        existing ? [] : [DEFAULT_ROW],
      );
      if (existing) mocks.findFirst.mockResolvedValueOnce(DEFAULT_ROW);
      const message = "Join the cost review.\nBring your questions.";
      await workspaceInviteSendHandler(
        { email: "note@example.com", role: "member", message },
        CTX,
      );
      await vi.waitFor(() => {
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "note@example.com",
            text: expect.stringContaining(message),
            html: expect.stringContaining(
              "Join the cost review.<br>Bring your questions.",
            ),
          }),
        );
      });
    },
  );
});
