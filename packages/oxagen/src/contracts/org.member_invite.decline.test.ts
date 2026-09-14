import { describe, expect, it } from "vitest";
import { orgMemberInviteDecline } from "./org.member_invite.decline";
import { getCapability } from "../registry";

describe("org.member.invite.decline capability", () => {
  it("parses a valid input", () => {
    const parsed = orgMemberInviteDecline.input.parse({
      invitationPublicId: "inv_abc",
    });
    expect(parsed.invitationPublicId).toBe("inv_abc");
  });

  it("rejects an empty invitationPublicId", () => {
    expect(() =>
      orgMemberInviteDecline.input.parse({ invitationPublicId: "" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = orgMemberInviteDecline.output.parse({
      invitationPublicId: "inv_abc",
      status: "declined",
    });
    expect(parsed.status).toBe("declined");
  });

  it("rejects an output whose status is not the 'declined' literal", () => {
    expect(() =>
      orgMemberInviteDecline.output.parse({
        invitationPublicId: "inv_abc",
        status: "pending",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("decline_member_invite")).toBe(orgMemberInviteDecline);
  });
});
