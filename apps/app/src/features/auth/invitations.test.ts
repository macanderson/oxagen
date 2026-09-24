import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideInvitation } from "./invitation";

// The invitation behind a token comes from the viewer seam's anonymous read
// (src/server/viewer.ts, tested beside it); here it is scripted per test.
const readInvitation = vi.fn();
vi.mock("@/server/viewer", () => ({ readInvitation }));

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
  inviterName: "Priya Natarajan",
  inviterRole: "Owner",
};
beforeEach(() => {
  readInvitation.mockReset();
});

describe("loadInvitation", () => {
  it("maps the record to the view model, the stored role to the spec's lowercase enum", async () => {
    readInvitation.mockResolvedValue(record);
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
        inviterName: "Priya Natarajan",
        inviterRole: "owner",
      },
    });
    expect(readInvitation).toHaveBeenCalledWith("invi_live");
  });

  it("reads an unknown or malformed token as not found (negative)", async () => {
    readInvitation.mockResolvedValue(null);
    expect(await loadInvitation("../../etc")).toEqual({
      ok: false,
      reason: "error",
      code: "invitation_not_found",
      status: 404,
    });
  });

  it("reads an expired invitation, which the page closes as expired", async () => {
    readInvitation.mockResolvedValue({
      ...record,
      expiresAt: new Date("2026-09-12T09:00:00Z"),
    });
    const read = await loadInvitation("invi_old");
    if (!read.ok) throw new Error("expected the invitation to read");
    expect(read.value.expiresAt).toBe("2026-09-12T09:00:00.000Z");
    expect(
      decideInvitation(read.value, null, new Date("2026-09-15T00:00:00Z")),
    ).toEqual({ kind: "closed", status: "expired", signedInAs: null });
  });

  it("reads a row outside the enums as an error (negative)", async () => {
    readInvitation.mockResolvedValue({
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

  it("an inviter whose role is unknown or who has no record reads as null, never as an error", async () => {
    readInvitation.mockResolvedValue({ ...record, inviterRole: "Superuser" });
    const unknownRole = await loadInvitation("invi_live");
    if (!unknownRole.ok) throw new Error("expected the invitation to read");
    expect(unknownRole.value.inviterRole).toBeNull();
    expect(unknownRole.value.inviterName).toBe("Priya Natarajan");

    readInvitation.mockResolvedValue({
      ...record,
      inviterName: null,
      inviterRole: null,
    });
    const noInviter = await loadInvitation("invi_live");
    if (!noInviter.ok) throw new Error("expected the invitation to read");
    expect(noInviter.value).toMatchObject({
      inviterName: null,
      inviterRole: null,
    });
  });
});
