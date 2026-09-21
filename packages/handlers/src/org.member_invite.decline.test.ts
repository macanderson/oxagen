import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { HandlerError, type CapabilityContext } from "@oxagen/oxagen";
const mocks = vi.hoisted(() => ({
  invitation: vi.fn(),
  user: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
  role: vi.fn(),
  actor: vi.fn(),
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withSystemDb: async (fn: (tx: unknown) => unknown) =>
    fn({
      query: {
        invitations: { findFirst: mocks.invitation },
        users: { findFirst: mocks.user },
      },
      update: mocks.update,
    }),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.role,
  resolveActingUserId: mocks.actor,
}));
import { orgMemberInviteDeclineHandler } from "./org.member_invite.decline";
const ctx = {
  userId: "user",
  orgId: "org-a",
  workspaceId: "ws-a",
  planTier: "free",
} as CapabilityContext;
const input = { invitationPublicId: "invi_abc" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue("user");
  mocks.invitation.mockResolvedValue({
    id: "row",
    publicId: input.invitationPublicId,
    orgId: "org-a",
    email: "person@example.com",
    status: "pending",
  });
  mocks.user.mockResolvedValue({ email: "PERSON@example.com" });
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ returning: mocks.returning });
  mocks.returning.mockResolvedValue([{ id: "row" }]);
});
describe("decline invitation authorization", () => {
  it("allows the invitee by case-insensitive email before membership", async () => {
    expect(
      await orgMemberInviteDeclineHandler(input, { ...ctx, orgId: "other" }),
    ).toMatchObject({ status: "declined" });
    expect(mocks.role).not.toHaveBeenCalled();
  });
  it("requires an org role for a different recipient even on free tier", async () => {
    mocks.user.mockResolvedValue({ email: "other@example.com" });
    mocks.role.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    await expect(
      orgMemberInviteDeclineHandler(input, ctx),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.role).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", userId: "user" }),
      { org: ["Owner", "Admin"] },
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("cannot use an admin role from another organization", async () => {
    mocks.user.mockResolvedValue({ email: "other@example.com" });
    await expect(
      orgMemberInviteDeclineHandler(input, { ...ctx, orgId: "other" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("allows a verified administrator in the target organization", async () => {
    mocks.user.mockResolvedValue({ email: "admin@example.com" });
    expect(await orgMemberInviteDeclineHandler(input, ctx)).toMatchObject({
      status: "declined",
    });
    expect(mocks.role).toHaveBeenCalledOnce();
  });
  it("refuses a machine with no acting user", async () => {
    mocks.actor.mockResolvedValue(null);
    await expect(
      orgMemberInviteDeclineHandler(input, ctx),
    ).rejects.toMatchObject({ reason: "no_principal" });
    expect(mocks.invitation).not.toHaveBeenCalled();
  });
  it("refuses an invitation accepted between read and write", async () => {
    mocks.returning.mockResolvedValue([]);
    await expect(
      orgMemberInviteDeclineHandler(input, ctx),
    ).rejects.toMatchObject({ reason: "invitation_closed" });
    const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0]?.[0]);
    expect(query.params).toEqual(
      expect.arrayContaining(["pending", "org-a", "row"]),
    );
  });
  it.each([undefined, { status: "accepted" }])(
    "refuses a missing or closed invitation",
    async (row) => {
      mocks.invitation.mockResolvedValue(
        row
          ? {
              id: "row",
              publicId: input.invitationPublicId,
              orgId: "org-a",
              email: "person@example.com",
              ...row,
            }
          : undefined,
      );
      await expect(
        orgMemberInviteDeclineHandler(input, ctx),
      ).rejects.toBeInstanceOf(HandlerError);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
});
