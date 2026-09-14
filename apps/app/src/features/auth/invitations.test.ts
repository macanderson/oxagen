import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeQuery } from "./test-query";

const query = {
  invitations: { findFirst: vi.fn() },
  organizations: { findFirst: vi.fn() },
  users: { findFirst: vi.fn() },
};
const filters: string[] = [];
function recorded(q: Record<string, { findFirst: (o: unknown) => unknown }>) {
  return Object.fromEntries(
    Object.entries(q).map(([table, m]) => [
      table,
      {
        findFirst: (options: Parameters<typeof describeQuery>[0]) => {
          filters.push(`${table} ${describeQuery(options).where ?? ""}`);
          return m.findFirst(options);
        },
      },
    ]),
  );
}
// Only the onboarding port is under test: the real live source loads every live
// adapter, whose @oxagen/database imports this file's partial mock does not carry.
vi.mock("@/data/adapters/live", async () => ({
  liveSource: {
    onboarding: (await import("@/data/adapters/live/onboarding"))
      .liveOnboarding,
  },
}));
vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) =>
    fn({ query: recorded(query) }),
}));

const getAuthUser = vi.fn();
vi.mock("./session", () => ({ getAuthUser }));
const invokeTool = vi.fn();
vi.mock("@/server/invoke", () => ({ invokeTool }));
const warn = vi.fn();
vi.mock("@oxagen/handlers/logger", () => ({ logger: { warn } }));
vi.mock("@oxagen/oxagen/contracts/org.member_invite.accept", () => ({
  orgMemberInviteAccept: { name: "accept_member_invite" },
}));
vi.mock("@oxagen/oxagen/contracts/org.member_invite.decline", () => ({
  orgMemberInviteDecline: { name: "decline_member_invite" },
}));

const { loadInvitation } = await import("./invitations");
const { acceptInvitation, declineInvitation } = await import(
  "./invite-actions"
);

const liveRow = {
  publicId: "invi_live",
  orgId: "0192f1c4-0000-7000-8000-000000000001",
  email: "priya@acme.example",
  role: "Admin",
  status: "pending",
  invitedByUserId: "u-owner",
  createdAt: new Date("2026-09-11T09:00:00Z"),
  expiresAt: new Date("2099-01-01T00:00:00Z"),
};

beforeEach(() => {
  filters.length = 0;
  for (const table of Object.values(query)) table.findFirst.mockReset();
  getAuthUser.mockReset();
  invokeTool.mockReset();
  warn.mockReset();
});

describe("loadInvitation", () => {
  it("refuses a malformed token without a lookup", async () => {
    expect(await loadInvitation("../../etc")).toEqual({
      ok: false,
      reason: "error",
      code: "invitation_not_found",
      status: 404,
    });
    expect(query.invitations.findFirst).not.toHaveBeenCalled();
  });

  it("maps a live row to the view model, the stored role to the spec's lowercase enum", async () => {
    query.invitations.findFirst.mockResolvedValue(liveRow);
    query.organizations.findFirst.mockResolvedValue({
      name: "Acme Robotics",
      slug: "acme",
    });
    query.users.findFirst.mockResolvedValue({ displayName: "Marcus Bell" });
    expect(await loadInvitation("invi_live")).toEqual({
      ok: true,
      value: {
        token: "invi_live",
        orgName: "Acme Robotics",
        orgSlug: "acme",
        email: "priya@acme.example",
        role: "admin",
        status: "pending",
        inviterName: "Marcus Bell",
        invitedAt: "2026-09-11T09:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    expect(filters).toEqual([
      "invitations eq(col:publicId,invi_live)",
      `organizations eq(col:id,${liveRow.orgId})`,
      "users eq(col:id,u-owner)",
    ]);
  });

  it("reads a missing invitation or organization as not found, and an unreadable row as an error", async () => {
    query.invitations.findFirst.mockResolvedValueOnce(undefined);
    expect((await loadInvitation("invi_gone")).ok).toBe(false);
    query.invitations.findFirst.mockResolvedValueOnce(liveRow);
    query.organizations.findFirst.mockResolvedValueOnce(undefined);
    query.users.findFirst.mockResolvedValueOnce(undefined);
    expect(await loadInvitation("invi_live")).toMatchObject({
      code: "invitation_not_found",
    });
    query.invitations.findFirst.mockResolvedValueOnce({
      ...liveRow,
      role: "Superuser",
      expiresAt: null,
    });
    query.organizations.findFirst.mockResolvedValueOnce({
      name: "Acme",
      slug: "acme",
    });
    query.users.findFirst.mockResolvedValueOnce(undefined);
    expect(await loadInvitation("invi_live")).toEqual({
      ok: false,
      reason: "error",
      code: "invitation_unreadable",
      status: 500,
    });
  });
});

describe("accept and decline", () => {
  it("re-runs the page's decision: unknown, closed, signed out and wrong account are refused, and nothing is written", async () => {
    getAuthUser.mockResolvedValue({
      id: "u-priya",
      email: "priya@acme.example",
      name: "Priya",
    });
    query.organizations.findFirst.mockResolvedValue({
      name: "Acme Robotics",
      slug: "acme",
    });
    query.users.findFirst.mockResolvedValue(undefined);
    query.invitations.findFirst.mockResolvedValueOnce(undefined);
    expect(await acceptInvitation("invi_nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
    query.invitations.findFirst.mockResolvedValueOnce({
      ...liveRow,
      status: "accepted",
    });
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "closed",
    });
    query.invitations.findFirst.mockResolvedValueOnce({
      ...liveRow,
      email: "someone.else@acme.example",
    });
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "wrong_account",
    });
    getAuthUser.mockResolvedValue(null);
    query.invitations.findFirst.mockResolvedValueOnce(liveRow);
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "sign_in",
    });
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("accepts through the kernel in the invitation's org scope", async () => {
    getAuthUser.mockResolvedValue({
      id: "u-priya",
      email: "priya@acme.example",
      name: "Priya",
    });
    query.invitations.findFirst.mockResolvedValue(liveRow);
    query.organizations.findFirst.mockResolvedValue({
      name: "Acme Robotics",
      slug: "acme",
    });
    query.users.findFirst.mockResolvedValue({ displayName: "Marcus Bell" });
    invokeTool.mockResolvedValue({});
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: true,
      to: "/acme",
    });
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-priya",
        scope: {
          orgId: liveRow.orgId,
          workspaceId: "00000000-0000-0000-0000-000000000000",
        },
        org: { id: liveRow.orgId, slug: "acme", name: "Acme Robotics" },
        ws: null,
      }),
      { name: "accept_member_invite" },
      { invitationPublicId: "invi_live" },
    );
    expect(await declineInvitation("invi_live")).toEqual({ ok: true, to: "/" });
    expect(invokeTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "u-priya" }),
      { name: "decline_member_invite" },
      { invitationPublicId: "invi_live" },
    );
  });

  it("a kernel failure is logged and reported, not thrown", async () => {
    getAuthUser.mockResolvedValue({
      id: "u-priya",
      email: "priya@acme.example",
      name: "Priya",
    });
    query.invitations.findFirst.mockResolvedValue(liveRow);
    query.organizations.findFirst.mockResolvedValue({
      name: "Acme Robotics",
      slug: "acme",
    });
    query.users.findFirst.mockResolvedValue(undefined);
    invokeTool.mockRejectedValue(new Error("iam denied"));
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("an invitation that vanished between read and write is not found", async () => {
    getAuthUser.mockResolvedValue({
      id: "u-priya",
      email: "priya@acme.example",
      name: "Priya",
    });
    query.invitations.findFirst
      .mockResolvedValueOnce(liveRow)
      .mockResolvedValueOnce(undefined);
    query.organizations.findFirst.mockResolvedValue({
      name: "Acme Robotics",
      slug: "acme",
    });
    query.users.findFirst.mockResolvedValue(undefined);
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(invokeTool).not.toHaveBeenCalled();
  });
});
