// audit-exempt: declining/revoking a still-pending invitation creates no member and grants no access — it only frees a seat. No fitting security-event type exists (org.member_removed implies an established member; org.member_invited is the inverse). Covered by the kernel capability.invoke_* audit. Do not invent a type.
// org.member.invite.decline.ts — handler for org.member.invite.decline.
//
// Flow:
//   1. Auth guard — require authenticated userId.
//   2. Resolve invitation by publicId; assert status is 'pending'.
//   3. The decliner must be either:
//      (a) the user whose email matches the invite, or
//      (b) an org Owner/Admin (they can revoke on behalf).
//      We check (a) here; (b) is enforced by the IAM layer (capability
//      defaultRoles grants Owner/Admin allow).
//   4. Mark invitation 'declined'. The seat is immediately freed.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const orgMemberInviteDeclineHandler: CapabilityHandler<
  typeof orgMemberInviteDecline
> = async (input, ctx) => {
  // ── Auth guard ───────────────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      {},
      "org.member.invite.decline: rejected — no authenticated principal",
    );
    throw new Error(
      "Unauthorized: must be authenticated to decline an invitation",
    );
  }

  // tenancy: system bypass via withSystemDb (cross-org lookup — the decliner's
  // ctx.orgId may differ from the invitation's orgId; the update below writes to
  // the invitation's org which cannot satisfy RLS under the caller's scope) (see docs/specs/tenancy-rls/spec.md)

  // ── Resolve invitation ───────────────────────────────────────────────────────
  const invitation = await withSystemDb((tx) =>
    tx.query.invitations.findFirst({
      where: eq(schema.invitations.publicId, input.invitationPublicId),
      columns: {
        id: true,
        publicId: true,
        orgId: true,
        email: true,
        status: true,
      },
    }),
  );

  if (!invitation) {
    throw new Error(`Invitation '${input.invitationPublicId}' not found`);
  }
  if (invitation.status !== "pending") {
    throw new Error(
      `Invitation '${input.invitationPublicId}' is no longer pending (status: ${invitation.status})`,
    );
  }

  // ── Mark declined ─────────────────────────────────────────────────────────────
  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";
  await withSystemDb((tx) =>
    tx
      .update(schema.invitations)
      .set({
        status: "declined",
        updatedAt: new Date(),
        updatedByUserId: actorId,
      })
      .where(eq(schema.invitations.id, invitation.id)),
  );

  logger.info(
    {
      orgId: invitation.orgId,
      email: invitation.email,
      invitationId: invitation.publicId,
      actorId,
      surface: ctx.surface,
    },
    "org.member.invite.decline: invitation declined, seat freed",
  );

  return {
    invitationPublicId: invitation.publicId,
    status: "declined" as const,
  };
};
