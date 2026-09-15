import { beforeEach, describe, expect, it, vi } from "vitest";

// The invitation behind a token comes from the system lookups seam
// (src/server/tenancy-lookups.ts, tested beside it); here it is scripted per test.
const invitationByToken = vi.fn();
vi.mock("@/server/tenancy-lookups", () => ({
  systemLookups: { invitationByToken },
}));

const getAuthUser = vi.fn();
vi.mock("./session", () => ({ getAuthUser }));
// requireInvitee reads the same person through the server session seam.
const getSession = vi.fn();
vi.mock("@/server/session", () => ({ getSession }));
const kernelWrite = vi.fn();
vi.mock("@/server/kernel", () => ({ kernelWrite }));
vi.mock("@oxagen/oxagen/contracts/org.member_invite.accept", () => ({
  orgMemberInviteAccept: { name: "accept_member_invite" },
}));
vi.mock("@oxagen/oxagen/contracts/org.member_invite.decline", () => ({
  orgMemberInviteDecline: { name: "decline_member_invite" },
}));

const { InviteeCtx } = await import("@/server/viewer");
const { loadInvitation } = await import("./invitations");
const { acceptInvitation, declineInvitation } = await import(
  "./invite-actions"
);

const record = {
  invitationId: "0192f1c4-0000-7000-8000-0000000000aa",
  orgId: "0192f1c4-0000-7000-8000-000000000001",
  orgName: "Acme Robotics",
  orgSlug: "acme",
  email: "priya@acme.example",
  role: "Admin",
  status: "pending",
  invitedAt: new Date("2026-09-11T09:00:00Z"),
  expiresAt: new Date("2099-01-01T00:00:00Z"),
};
const priya = {
  id: "u-priya",
  email: "priya@acme.example",
  name: "Priya",
};

beforeEach(() => {
  invitationByToken.mockReset();
  getAuthUser.mockReset();
  getSession.mockResolvedValue({ user: priya });
  kernelWrite.mockReset();
});

describe("loadInvitation", () => {
  it("refuses a malformed token without a lookup", async () => {
    expect(await loadInvitation("../../etc")).toEqual({
      ok: false,
      reason: "error",
      code: "invitation_not_found",
      status: 404,
    });
    expect(invitationByToken).not.toHaveBeenCalled();
  });

  it("maps the record to the view model, the stored role to the spec's lowercase enum", async () => {
    invitationByToken.mockResolvedValue(record);
    expect(await loadInvitation("invi_live")).toEqual({
      ok: true,
      value: {
        token: "invi_live",
        orgName: "Acme Robotics",
        orgSlug: "acme",
        email: "priya@acme.example",
        role: "admin",
        status: "pending",
        invitedAt: "2026-09-11T09:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    expect(invitationByToken).toHaveBeenCalledWith("invi_live");
  });

  it("reads a missing invitation as not found, and a row outside the enums as an error", async () => {
    invitationByToken.mockResolvedValueOnce(null);
    expect(await loadInvitation("invi_gone")).toMatchObject({
      ok: false,
      code: "invitation_not_found",
    });
    invitationByToken.mockResolvedValueOnce({
      ...record,
      role: "Superuser",
      expiresAt: null,
    });
    expect(await loadInvitation("invi_live")).toEqual({
      ok: false,
      reason: "error",
      code: "invitation_unreadable",
      status: 500,
    });
  });
});

describe("accept and decline", () => {
  it("re-runs the page's decision: malformed, unknown, unreadable, closed, signed out and wrong account are refused, and nothing is written", async () => {
    getAuthUser.mockResolvedValue(priya);
    expect(await acceptInvitation("../../etc")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(invitationByToken).not.toHaveBeenCalled();
    invitationByToken.mockResolvedValueOnce(null);
    expect(await acceptInvitation("invi_nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
    invitationByToken.mockResolvedValueOnce({ ...record, role: "Superuser" });
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "not_found",
    });
    invitationByToken.mockResolvedValueOnce({ ...record, status: "accepted" });
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "closed",
    });
    invitationByToken.mockResolvedValueOnce({
      ...record,
      email: "someone.else@acme.example",
    });
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "wrong_account",
    });
    getAuthUser.mockResolvedValue(null);
    invitationByToken.mockResolvedValueOnce(record);
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "sign_in",
    });
    expect(kernelWrite).not.toHaveBeenCalled();
  });

  it("accepts through the kernel in the org the record names", async () => {
    getAuthUser.mockResolvedValue(priya);
    invitationByToken.mockResolvedValue(record);
    kernelWrite.mockResolvedValue({ ok: true, value: {} });
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: true,
      to: "/acme",
    });
    expect(kernelWrite).toHaveBeenCalledWith(
      {
        userId: "u-priya",
        orgId: record.orgId,
        invitationId: record.invitationId,
      },
      { name: "accept_member_invite" },
      { invitationPublicId: "invi_live" },
    );
    expect(InviteeCtx.is(kernelWrite.mock.calls[0]?.[0])).toBe(true);
    expect(await declineInvitation("invi_live")).toEqual({ ok: true, to: "/" });
    expect(kernelWrite).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "u-priya" }),
      { name: "decline_member_invite" },
      { invitationPublicId: "invi_live" },
    );
    // Two reads per decision: the page's decision, then requireInvitee's.
    expect(invitationByToken).toHaveBeenCalledTimes(4);
  });

  it("a kernel refusal is reported as failed (negative)", async () => {
    getAuthUser.mockResolvedValue(priya);
    invitationByToken.mockResolvedValue(record);
    kernelWrite.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "invitation_closed",
    });
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});
