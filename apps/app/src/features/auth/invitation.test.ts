import { describe, expect, it } from "vitest";
import { type InvitationView, toOrgRole } from "@/data/contracts/invitations";
import { decideInvitation } from "./invitation";

const base: InvitationView = {
  token: "invi_01",
  orgName: "Acme Robotics",
  orgSlug: "acme",
  email: "marcus.bell@acme.example",
  role: "member",
  status: "pending",
  inviterName: "Priya Raman",
  invitedAt: "2026-09-11T09:00:00.000Z",
  expiresAt: "2026-09-18T09:00:00.000Z",
};
const now = new Date("2026-09-12T12:00:00.000Z");

describe("decideInvitation", () => {
  it("offers accept to the invited account", () => {
    expect(decideInvitation(base, "Marcus.Bell@acme.example", now)).toEqual({
      kind: "accept",
    });
  });

  it("asks a signed-out visitor to sign in first", () => {
    expect(decideInvitation(base, null, now)).toEqual({ kind: "sign-in" });
  });

  it("refuses a different signed-in account", () => {
    expect(decideInvitation(base, "dana.okafor@acme.example", now)).toEqual({
      kind: "wrong-account",
      signedInAs: "dana.okafor@acme.example",
    });
  });

  it("closes an invitation that is no longer pending", () => {
    expect(
      decideInvitation({ ...base, status: "accepted" }, base.email, now),
    ).toEqual({
      kind: "closed",
      status: "accepted",
    });
  });

  it("closes a pending invitation past its expiry as expired", () => {
    expect(
      decideInvitation(
        { ...base, expiresAt: "2026-09-12T11:59:59.000Z" },
        base.email,
        now,
      ),
    ).toEqual({
      kind: "closed",
      status: "expired",
    });
  });

  it("keeps a pending invitation with no expiry open", () => {
    expect(
      decideInvitation({ ...base, expiresAt: null }, base.email, now),
    ).toEqual({ kind: "accept" });
  });
});

describe("toOrgRole", () => {
  it("reads the stored Title-cased role as the spec enum", () => {
    expect(toOrgRole("Admin")).toBe("admin");
    expect(toOrgRole(" compliance ")).toBe("compliance");
  });

  it("refuses a role outside the closed set", () => {
    expect(toOrgRole("Superuser")).toBeNull();
  });
});
