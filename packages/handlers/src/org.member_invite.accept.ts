// org.member.invite.accept.ts — handler for org.member.invite.accept.
//
// Flow:
//   1. Auth guard — require authenticated userId.
//   2. Resolve invitation by publicId; assert status is 'pending'.
//   3. Verify the authenticated user's email matches the invite email
//      (prevents a different user from accepting someone else's invite).
//   4. In a transaction:
//      a. Mark invitation 'accepted', set acceptedUserId.
//      b. Insert org_users row (least-privilege membership).
//      c. provisionMemberPrincipal (IAM principal, no role grants yet).
//      d. Assign the invited `role` to the new principal.
//   5. Return the org_users row shape.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq } from "drizzle-orm";
import { provisionMemberPrincipal } from "./iam-provision";
import { logger } from "./logger";

export const orgMemberInviteAcceptHandler: CapabilityHandler<
  typeof orgMemberInviteAccept
> = async (input, ctx) => {
  // ── Auth guard ───────────────────────────────────────────────────────────────
  if (!ctx.userId) {
    logger.warn(
      {},
      "org.member.invite.accept: rejected — no authenticated userId",
    );
    throw new Error(
      "Unauthorized: must be authenticated to accept an invitation",
    );
  }

  // tenancy: system bypass via withSystemDb (cross-org lookup — the invitee's
  // ctx.orgId may differ from the invitation's orgId; the writes below go to the
  // invitation's org, which cannot satisfy RLS under the caller's scope) (see docs/specs/tenancy-rls/spec.md)

  // ── Resolve invitation ───────────────────────────────────────────────────────
  const invitation = await withSystemDb((tx) =>
    tx.query.invitations.findFirst({
      where: eq(schema.invitations.publicId, input.invitationPublicId),
      columns: {
        id: true,
        publicId: true,
        orgId: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
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
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    // Mark expired to keep state consistent; don't block on failure.
    await withSystemDb((tx) =>
      tx
        .update(schema.invitations)
        .set({
          status: "expired",
          updatedAt: new Date(),
          updatedByUserId: ctx.userId,
        })
        .where(eq(schema.invitations.id, invitation.id)),
    ).catch((err) =>
      logger.warn(
        { err, invitationPublicId: input.invitationPublicId },
        "invite.accept: failed to mark expired invitation — row remains pending",
      ),
    );
    throw new Error(`Invitation '${input.invitationPublicId}' has expired`);
  }

  // ── Verify email matches ──────────────────────────────────────────────────────
  const [userRow] = await withSystemDb((tx) =>
    tx
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, ctx.userId!))
      .limit(1),
  );

  if (!userRow) throw new Error("Authenticated user not found");
  // Case-insensitive comparison — email is citext in the DB.
  if (userRow.email.toLowerCase() !== invitation.email.toLowerCase()) {
    logger.warn(
      {
        orgId: invitation.orgId,
        invitationId: invitation.publicId,
        userId: ctx.userId,
      },
      "org.member.invite.accept: email mismatch",
    );
    throw new Error("This invitation was not issued to your email address");
  }

  // ── Transaction: accept + create membership + provision IAM ──────────────────
  // All writes go to the invitation's org via withSystemDb (cross-org write;
  // the invitee's ctx.orgId may differ from invitation.orgId).
  const joinedAt = new Date();

  const result = await withSystemDb(async (tx) => {
    // (a) Mark invitation accepted.
    // NOTE: the pending/expiry checks above ran in an EARLIER transaction and
    // this UPDATE does not re-assert `status = 'pending'`, so it is not a
    // compare-and-swap. An invitation revoked (or accepted a second time)
    // between the check and here is still accepted.
    await tx
      .update(schema.invitations)
      .set({
        status: "accepted",
        acceptedUserId: ctx.userId,
        updatedAt: joinedAt,
        updatedByUserId: ctx.userId,
      })
      .where(eq(schema.invitations.id, invitation.id));

    // (b) Insert org_users row.
    const [orgUser] = await tx
      .insert(schema.orgUsers)
      .values({
        orgId: invitation.orgId,
        userId: ctx.userId!,
        role: invitation.role,
        joinedAt,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({ publicId: schema.orgUsers.publicId });

    // If the row already existed (race or re-accept), re-select it.
    let orgUserPublicId: string;
    if (orgUser) {
      orgUserPublicId = orgUser.publicId;
    } else {
      const [existing] = await tx
        .select({ publicId: schema.orgUsers.publicId })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, invitation.orgId),
            eq(schema.orgUsers.userId, ctx.userId!),
          ),
        )
        .limit(1);
      if (!existing)
        throw new Error(
          "org_users insert returned no row and re-select failed",
        );
      orgUserPublicId = existing.publicId;
    }

    // (c) Provision least-privilege IAM principal (idempotent).
    const principalId = await provisionMemberPrincipal({
      orgId: invitation.orgId,
      userId: ctx.userId!,
      actorUserId: ctx.userId!,
      tx,
    });

    // (d) Assign the invited role to the principal.
    // The role is the org role name (e.g. 'Admin', 'Member'). Look it up.
    const [roleRow] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.orgId, invitation.orgId),
          eq(schema.roles.scopeKind, "org"),
          eq(schema.roles.name, invitation.role),
        ),
      )
      .limit(1);

    if (roleRow) {
      await tx
        .insert(schema.principalRoleAssignments)
        .values({
          principalId,
          roleId: roleRow.id,
          orgId: invitation.orgId,
          assignedBy: ctx.userId,
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .onConflictDoNothing();
    } else {
      logger.warn(
        { orgId: invitation.orgId, role: invitation.role },
        "org.member.invite.accept: role not found — membership created without role assignment",
      );
    }

    return { orgUserPublicId };
  });

  logger.info(
    {
      orgId: invitation.orgId,
      userId: ctx.userId,
      role: invitation.role,
      invitationId: invitation.publicId,
      surface: ctx.surface,
    },
    "org.member.invite.accept: invitation accepted, membership created",
  );

  // Emit org.role_changed: the new member's initial role assignment (none → role)
  // is the first role change on their principal. Fire-and-forget so an audit
  // failure never breaks the accept flow.
  emitSecurityEvent({
    eventType: "org.role_changed",
    actorUserId: ctx.userId,
    orgId: invitation.orgId,
    workspaceId: null,
    capability: "accept_member_invite",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  return {
    orgUserId: result.orgUserPublicId,
    orgId: invitation.orgId,
    role: invitation.role,
    joinedAt: joinedAt.toISOString(),
  };
};
