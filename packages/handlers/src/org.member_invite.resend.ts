import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { resendMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.resend";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { manageInvitation } from "./lib/manage-invitation";

export const handler: CapabilityHandler<typeof resendMemberInvite> = async (
  input,
  ctx,
) => {
  const userId = await resolveActingUserId(ctx);
  if (!userId)
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  return manageInvitation("resend", input.invitationPublicId, ctx, userId);
};
