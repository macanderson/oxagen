import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceInviteSend } from "@oxagen/oxagen/contracts/workspace.invite.send";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger, maskEmail } from "./logger";

function mapRole(role: "member" | "admin" | "owner"): string {
  const map: Record<string, string> = {
    member: "Member",
    admin: "Admin",
    owner: "Owner",
  };
  return map[role] ?? "Member";
}

export const workspaceInviteSendHandler: CapabilityHandler<typeof workspaceInviteSend> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "workspace.invite.send: rejected — no authenticated user");
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
      throw new Error("workspace.invite.send: conflict on insert but no existing pending invite found");
    }
    return existing;
  });

  logger.info(
    { orgId: ctx.orgId, email: maskEmail(input.email), role: orgRole },
    "workspace.invite.send: invitation created or returned existing",
  );

  return {
    id: row.publicId,
    status: row.status,
    expires_at: (row.expiresAt ?? expiresAt).toISOString(),
  };
};
