import { describe, expect, it } from "vitest";
import { orgMemberInviteAccept } from "./org.member_invite.accept";
import { getCapability } from "../registry";

describe("org.member.invite.accept capability", () => {
  it("parses a valid input", () => {
    const parsed = orgMemberInviteAccept.input.parse({
      invitationPublicId: "inv_abc",
    });
    expect(parsed.invitationPublicId).toBe("inv_abc");
  });

  it("rejects an empty invitationPublicId", () => {
    expect(() =>
      orgMemberInviteAccept.input.parse({ invitationPublicId: "" }),
    ).toThrow();
  });

  it("rejects a missing invitationPublicId", () => {
    expect(() => orgMemberInviteAccept.input.parse({})).toThrow();
  });

  it("parses a valid membership output", () => {
    const parsed = orgMemberInviteAccept.output.parse({
      orgUserId: "oru_1",
      orgId: "org_1",
      role: "Member",
      joinedAt: "2026-06-06T00:00:00.000Z",
    });
    expect(parsed.orgUserId).toBe("oru_1");
  });

  it("rejects an output missing joinedAt", () => {
    expect(() =>
      orgMemberInviteAccept.output.parse({
        orgUserId: "oru_1",
        orgId: "org_1",
        role: "Member",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("accept_member_invite")).toBe(orgMemberInviteAccept);
  });

  it("allows the invitee to accept (defaultEffect allow, low risk)", () => {
    expect(orgMemberInviteAccept.defaultEffect).toBe("allow");
    expect(orgMemberInviteAccept.agent?.riskLevel).toBe("low");
  });
});
