import { beforeEach, describe, expect, it, vi } from "vitest";

// The invitation behind a token comes from the system lookups seam
// (src/server/tenancy-lookups.ts, tested beside it); here it is scripted per test.
const invitationByToken = vi.fn();
vi.mock("@/server/tenancy-lookups", () => ({
  systemLookups: { invitationByToken },
}));

const { loadInvitation } = await import("./invitations");

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
beforeEach(() => {
  invitationByToken.mockReset();
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
