import { describe, expect, it } from "vitest";
import { resendMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.resend";
describe("resend_member_invite boundary", () => {
  it("uses the stored recipient and role instead of caller replacements", () => {
    expect(
      resendMemberInvite.input.safeParse({ invitationPublicId: "invi_abc" })
        .success,
    ).toBe(true);
    expect(
      resendMemberInvite.input.safeParse({
        invitationPublicId: "invi_abc",
        email: "other@example.com",
        role: "owner",
      }).success,
    ).toBe(false);
  });
});
