import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  where: vi.fn(),
  lock: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  updateWhere: vi.fn(),
  actor: vi.fn(),
  role: vi.fn(),
  send: vi.fn(),
  template: vi.fn(),
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: async (fn: (tx: unknown) => unknown) =>
    fn({
      select: mocks.select,
      update: mocks.update,
      query: { organizations: { findFirst: async () => ({ name: "Acme" }) } },
    }),
  withSystemDb: async (fn: (tx: unknown) => unknown) =>
    fn({
      query: { users: { findFirst: async () => ({ displayName: "Owner" }) } },
    }),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.role,
  resolveActingUserId: mocks.actor,
}));
vi.mock("@oxagen/notifications", () => ({
  sendEmail: mocks.send,
  invitationEmailTemplate: mocks.template,
}));
import { handler as resend } from "../org.member_invite.resend";
import { handler as revoke } from "../org.member_invite.revoke";
const ctx = {
  userId: "user",
  orgId: "org-a",
  workspaceId: "workspace",
  planTier: "free",
} as CapabilityContext;
const input = { invitationPublicId: "invi_abc" };
const row = {
  id: "row",
  publicId: input.invitationPublicId,
  orgId: ctx.orgId,
  email: "person@example.com",
  role: "Member",
  status: "pending",
  expiresAt: new Date(0),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.template.mockReturnValue({ subject: "Invitation", html: "body" });
  mocks.actor.mockResolvedValue("user");
  mocks.select.mockReturnValue({ from: () => ({ where: mocks.where }) });
  mocks.where.mockReturnValue({ for: mocks.lock });
  mocks.lock.mockResolvedValue([row]);
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.updateWhere });
  mocks.updateWhere.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue({
    accepted: [row.email],
    rejected: [],
    id: "mail",
  });
});
describe("invitation management", () => {
  it.each([resend, revoke])(
    "requires a current org role before reading invitations",
    async (handler) => {
      mocks.role.mockRejectedValue(
        new HandlerError({ code: "forbidden", reason: "org_role_required" }),
      );
      await expect(handler(input, ctx)).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(mocks.role).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user", orgId: "org-a" }),
        { org: ["Owner", "Admin"] },
      );
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );
  it("resends the same invitation and extends its expiry", async () => {
    const result = await resend(input, ctx);
    expect(result).toMatchObject({
      invitationPublicId: input.invitationPublicId,
      status: "pending",
    });
    expect(Date.parse(result.expiresAt ?? "")).toBeGreaterThan(
      Date.now() + 6 * 86_400_000,
    );
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: row.email }),
    );
    expect(mocks.template).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteUrl: `${process.env.APP_URL ?? "https://app.oxagen.sh"}/invite/${row.publicId}`,
      }),
    );
    expect(mocks.lock).toHaveBeenCalledWith("update");
    const clause = mocks.where.mock.calls[0]?.[0];
    const query = new PgDialect().sqlToQuery(clause);
    expect(query.params).toEqual(
      expect.arrayContaining([ctx.orgId, input.invitationPublicId]),
    );
  });
  it("revokes without sending email or changing the offered role", async () => {
    expect(await revoke(input, ctx)).toMatchObject({ status: "revoked" });
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "revoked", updatedById: "user" }),
    );
    expect(mocks.set.mock.calls[0]?.[0]).not.toHaveProperty("role");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(["accepted", "revoked", "declined"])(
    "refuses %s invitations without sending",
    async (status) => {
      mocks.lock.mockResolvedValue([{ ...row, status }]);
      await expect(resend(input, ctx)).rejects.toMatchObject({
        reason: "invitation_closed",
      });
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it("cannot mutate a missing or foreign invitation", async () => {
    mocks.lock.mockResolvedValue([]);
    await expect(revoke(input, ctx)).rejects.toMatchObject({
      reason: "invitation_not_found",
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not claim success when the transport rejects the recipient", async () => {
    mocks.send.mockResolvedValue({
      accepted: [],
      rejected: [row.email],
      id: "mail",
    });
    await expect(resend(input, ctx)).rejects.toThrow("email could not be sent");
  });
  it("can retry a transport failure against the same pending invitation", async () => {
    mocks.send.mockRejectedValueOnce(new Error("offline"));
    await expect(resend(input, ctx)).rejects.toThrow("email could not be sent");
    expect(await resend(input, ctx)).toMatchObject({
      invitationPublicId: input.invitationPublicId,
    });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
});
