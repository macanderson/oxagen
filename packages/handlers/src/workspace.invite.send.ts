import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceInviteSend } from "@oxagen/oxagen/contracts/workspace.invite.send";
import { schema, withTenantDb, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq } from "drizzle-orm";
import { sendEmail, invitationEmailTemplate } from "@oxagen/notifications";
import { logger, maskEmail } from "./logger";

/** Map workspace-level invite role to title-cased org-level role. */
function mapRole(role: "member" | "admin" | "owner"): string {
  const map: Record<string, string> = {
    member: "Member",
    admin: "Admin",
    owner: "Owner",
  };
  return map[role] ?? "Member";
}

export const workspaceInviteSendHandler: CapabilityHandler<
  typeof workspaceInviteSend
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "workspace.invite.send: rejected — no authenticated user",
    );
    throw new Error("workspace.invite.send requires an authenticated user");
  }

  const expiresAt = new Date(Date.now() + 7 * 864e5);
  const orgRole = mapRole(input.role);

  const row = await withTenantDb(async (tx) => {
    const inserted = await tx
      .insert(schema.invitations)
      .values({
        orgId: ctx.orgId,
        email: input.email,
        role: orgRole,
        status: "pending",
        invitedByUserId: ctx.userId!,
        expiresAt,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({
        publicId: schema.invitations.publicId,
        status: schema.invitations.status,
        expiresAt: schema.invitations.expiresAt,
      });

    if (inserted[0]) {
      return inserted[0];
    }

    // A pending invite for this (org, email) already exists — return it.
    const existing = await tx.query.invitations.findFirst({
      where: and(
        eq(schema.invitations.orgId, ctx.orgId),
        eq(schema.invitations.email, input.email),
        eq(schema.invitations.status, "pending"),
      ),
      columns: {
        publicId: true,
        status: true,
        expiresAt: true,
      },
    });

    if (!existing) {
      throw new Error(
        "workspace.invite.send: conflict on insert but no existing pending invite found",
      );
    }
    return existing;
  });

  logger.info(
    { orgId: ctx.orgId, email: maskEmail(input.email), role: orgRole },
    "workspace.invite.send: invitation created or returned existing",
  );

  // SOC2 audit: a privileged member-invitation was issued. Mirrors the
  // org.member.add emit so both invite paths leave an audit trail. The
  // org.member_invited taxonomy entry fits exactly. Fire-and-forget — an
  // audit-write failure must never break the invite.
  emitSecurityEvent({
    eventType: "org.member_invited",
    actorUserId: ctx.userId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "send_workspace_invite",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  // Best-effort: send invitation email. Failure here must never break the
  // invitation creation (critical path). Wrapped in try-catch + fire-and-forget.
  void (async () => {
    try {
      // Resolve inviter display name from the system-scoped users table.
      const inviterRow = await withSystemDb((tx) =>
        tx.query.users.findFirst({
          where: eq(schema.users.id, ctx.userId!),
          columns: { displayName: true },
        }),
      );
      const inviterName = inviterRow?.displayName ?? "A team member";

      // Resolve org name from the tenant-scoped organizations table.
      const orgRow = await withTenantDb((tx) =>
        tx.query.organizations.findFirst({
          where: eq(schema.organizations.id, ctx.orgId),
          columns: { name: true },
        }),
      );
      const orgName = orgRow?.name ?? ctx.orgId;

      const appUrl = process.env["APP_URL"] ?? "https://app.oxagen.sh";
      const inviteUrl = `${appUrl}/invitations/${row.publicId}`;

      await sendEmail({
        to: input.email,
        ...invitationEmailTemplate({
          inviteUrl,
          inviterName,
          orgName,
          role: orgRole,
          email: input.email,
        }),
      });
    } catch (err) {
      logger.warn(
        { orgId: ctx.orgId, email: maskEmail(input.email), err },
        "workspace.invite.send: failed to send invitation email (non-fatal)",
      );
    }
  })();

  return {
    id: row.publicId,
    status: row.status,
    expires_at: (row.expiresAt ?? expiresAt).toISOString(),
  };
};
