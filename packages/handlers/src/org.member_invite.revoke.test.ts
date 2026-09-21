import { describe, expect, it } from "vitest";
import { revokeMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.revoke";
describe("revoke_member_invite boundary", () => {
  it("accepts only the invitation public ID, never a caller-selected organization", () => {
    expect(
      revokeMemberInvite.input.safeParse({ invitationPublicId: "invi_abc" })
        .success,
    ).toBe(true);
    expect(
      revokeMemberInvite.input.safeParse({
        invitationPublicId: "invi_abc",
        orgId: "other",
      }).success,
    ).toBe(false);
    expect(
      revokeMemberInvite.input.safeParse({ invitationPublicId: "raw-id" })
        .success,
    ).toBe(false);
  });
});
