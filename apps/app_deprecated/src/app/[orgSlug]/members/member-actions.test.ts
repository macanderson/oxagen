/**
 * member-actions.test.ts — unit tests for removeMemberAction and
 * changeMemberRoleAction.
 *
 * Covers:
 *   removeMemberAction:
 *     - validation: empty orgSlug, empty targetUserId → {ok:false}
 *     - assertOrgMember called before invoke
 *     - invoke failure → {ok:false, error}
 *     - happy path → {ok:true}, revalidatePath called
 *   changeMemberRoleAction:
 *     - validation: empty newRole → {ok:false}
 *     - invoke failure → {ok:false, error}
 *     - happy path → {ok:true}, revalidatePath called
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockAssertOrgMember,
  mockInvoke,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockInvoke: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
// Side-effect import — mock as no-op so the module resolves.
vi.mock("@oxagen/handlers/register", () => ({}));

import { removeMemberAction, changeMemberRoleAction } from "./member-actions";

const ORG = { id: "org-1", slug: "acme" };
const SESSION = { user: { id: "caller-1" } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("removeMemberAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns {ok:false} when orgSlug is empty (validation)", async () => {
    const res = await removeMemberAction({
      orgSlug: "",
      targetUserId: "user-2",
    });
    expect(res.ok).toBe(false);
  });

  it("returns {ok:false} when targetUserId is empty (validation)", async () => {
    const res = await removeMemberAction({ orgSlug: "acme", targetUserId: "" });
    expect(res.ok).toBe(false);
  });

  it("asserts org membership before invoking the capability", async () => {
    await removeMemberAction({ orgSlug: "acme", targetUserId: "user-2" });
    expect(mockAssertOrgMember).toHaveBeenCalledWith(ORG.id, SESSION.user.id);
    expect(mockInvoke).toHaveBeenCalledWith(
      "remove_org_member",
      { targetUserId: "user-2" },
      expect.objectContaining({ orgId: ORG.id, userId: SESSION.user.id }),
      { surface: "agent" },
    );
  });

  it("returns {ok:true} and revalidates on success", async () => {
    const res = await removeMemberAction({
      orgSlug: "acme",
      targetUserId: "user-2",
    });
    expect(res).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members");
  });

  it("returns {ok:false, error} when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Forbidden: insufficient role"));
    const res = await removeMemberAction({
      orgSlug: "acme",
      targetUserId: "user-2",
    });
    expect(res).toMatchObject({
      ok: false,
      error: "Forbidden: insufficient role",
    });
  });
});

describe("changeMemberRoleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockAssertOrgMember.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(undefined);
  });

  it("returns {ok:false} when newRole is empty (validation)", async () => {
    const res = await changeMemberRoleAction({
      orgSlug: "acme",
      targetUserId: "user-2",
      newRole: "",
    });
    expect(res.ok).toBe(false);
  });

  it("returns {ok:true} and revalidates on success", async () => {
    const res = await changeMemberRoleAction({
      orgSlug: "acme",
      targetUserId: "user-2",
      newRole: "admin",
    });
    expect(res).toEqual({ ok: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/members");
    expect(mockInvoke).toHaveBeenCalledWith(
      "change_member_role",
      { targetUserId: "user-2", newRole: "admin" },
      expect.objectContaining({ orgId: ORG.id }),
      { surface: "agent" },
    );
  });

  it("returns {ok:false, error} when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Cannot demote the last owner"));
    const res = await changeMemberRoleAction({
      orgSlug: "acme",
      targetUserId: "user-2",
      newRole: "member",
    });
    expect(res).toMatchObject({
      ok: false,
      error: "Cannot demote the last owner",
    });
  });
});
