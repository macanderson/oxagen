// audit-exempt: declining a pending invitation grants no access. The kernel records this write.
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import { schema, withSystemDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";

export const orgMemberInviteDeclineHandler: CapabilityHandler<
  typeof orgMemberInviteDecline
> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  if (!userId)
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  // tenancy: looks up the invitation by public id before the invitee has any
  // orgId membership in the inviting organization; the role check below
  // verifies membership once the invitation's org is known.
  const invitation = await withSystemDb((tx) =>
    tx.query.invitations.findFirst({
      where: and(eq(schema.invitations.publicId, input.invitationPublicId)),
      columns: {
        id: true,
        publicId: true,
        orgId: true,
        email: true,
        status: true,
      },
    }),
  );
  if (!invitation)
    throw new HandlerError({
      code: "not_found",
      reason: "invitation_not_found",
    });
  // tenancy: resolves the acting user's email by userId, independent of any
  // orgId, to compare against the invitation's recipient before that user's
  // membership in the invitation's organization is confirmed.
  const user = await withSystemDb((tx) =>
    tx.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { email: true },
    }),
  );
  if (user?.email.toLowerCase() !== invitation.email.toLowerCase()) {
    if (ctx.orgId !== invitation.orgId)
      throw new HandlerError({ code: "forbidden", reason: "wrong_email" });
    await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  }
  if (invitation.status !== "pending")
    throw new HandlerError({ code: "conflict", reason: "invitation_closed" });
  // tenancy: the update is scoped by orgId and the pending status inline,
  // so this system call cannot cross tenant boundaries even without a
  // caller-scoped org context.
  const [changed] = await withSystemDb((tx) =>
    tx
      .update(schema.invitations)
      .set({ status: "declined", updatedAt: new Date(), updatedById: userId })
      .where(
        and(
          eq(schema.invitations.id, invitation.id),
          eq(schema.invitations.orgId, invitation.orgId),
          eq(schema.invitations.status, "pending"),
        ),
      )
      .returning({ id: schema.invitations.id }),
  );
  if (!changed)
    throw new HandlerError({ code: "conflict", reason: "invitation_closed" });
  return { invitationPublicId: invitation.publicId, status: "declined" };
};
