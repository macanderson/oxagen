/**
 * Unit tests for org.member.invite.decline handler.
 *
 * Scenarios:
 *  1. No authenticated principal → throws Unauthorized
 *  2. Invitation not found → throws
 *  3. Invitation not pending → throws
 *  4. Happy path → marks invitation declined (seat freed)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── drizzle-orm mock ─────────────────────────────────────────────────────────

// ── @oxagen/database mock ────────────────────────────────────────────────────

const mockUpdate = vi.fn();

const mockDb = {
  query: {
    invitations: { findFirst: vi.fn() },
  },
  update: mockUpdate,
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => mockDb,
    // withSystemDb passthrough: forward each call to mockDb so existing mock
    // chains (query.invitations.findFirst, update) apply.
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
  };
});

const { orgMemberInviteDeclineHandler } = await import(
  "./org.member_invite.decline"
);

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, unknown> = {}): CapabilityContext {
  return {
    userId: "user-decliner",
    apiKeyId: null,
    orgId: "org-abc",
    workspaceId: "ws-abc",
    surface: "api",
    planTier: "build",
    ...overrides,
  } as CapabilityContext;
}

function makeInvitation(status = "pending") {
  return {
    id: "inv-uuid-001",
    publicId: "inv_DECLINE01",
    orgId: "org-abc",
    email: "bob@example.com",
    status,
  };
}

function makeUpdateChain() {
  const setCalled = vi.fn().mockReturnThis();
  const whereCalled = vi.fn().mockResolvedValue(undefined);
  return { set: setCalled, where: whereCalled };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("orgMemberInviteDeclineHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no authenticated principal → throws Unauthorized", async () => {
    const ctx = makeCtx({ userId: null, apiKeyId: null });
    await expect(
      orgMemberInviteDeclineHandler({ invitationPublicId: "inv_X" }, ctx),
    ).rejects.toThrow("Unauthorized");
    expect(mockDb.query.invitations.findFirst).not.toHaveBeenCalled();
  });

  it("invitation not found → throws", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(undefined);
    const ctx = makeCtx();
    await expect(
      orgMemberInviteDeclineHandler({ invitationPublicId: "inv_MISSING" }, ctx),
    ).rejects.toThrow("not found");
  });

  it("invitation already declined → throws 'no longer pending'", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(
      makeInvitation("declined"),
    );
    const ctx = makeCtx();
    await expect(
      orgMemberInviteDeclineHandler(
        { invitationPublicId: "inv_DECLINE01" },
        ctx,
      ),
    ).rejects.toThrow("no longer pending");
  });

  it("happy path → returns declined status, does not throw", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(
      makeInvitation("pending"),
    );
    mockUpdate.mockReturnValue(makeUpdateChain());

    const ctx = makeCtx();
    const result = await orgMemberInviteDeclineHandler(
      { invitationPublicId: "inv_DECLINE01" },
      ctx,
    );

    expect(result).toEqual({
      invitationPublicId: "inv_DECLINE01",
      status: "declined",
    });
    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it("happy path via apiKeyId (no userId) → still declines", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(
      makeInvitation("pending"),
    );
    mockUpdate.mockReturnValue(makeUpdateChain());

    const ctx = makeCtx({ userId: null, apiKeyId: "api-key-001" });
    const result = await orgMemberInviteDeclineHandler(
      { invitationPublicId: "inv_DECLINE01" },
      ctx,
    );

    expect(result.status).toBe("declined");
  });
});
