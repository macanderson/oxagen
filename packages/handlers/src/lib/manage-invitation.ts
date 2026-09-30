import { HandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { sendEmail, invitationEmailTemplate } from "@oxagen/notifications";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger";

// audit-exempt: the kernel records these invitation-management writes. Revocation creates no membership; resend repeats an existing offer.
export async function manageInvitation<V extends "resend" | "revoke">(
  verb: V,
  publicId: string,
  ctx: CapabilityContext,
  userId: string,
): Promise<{
  invitationPublicId: string;
  status: V extends "resend" ? "pending" : "revoked";
  expiresAt: string | null;
  delivery?: "accepted" | "failed";
}> {
  const now = new Date();
  const row = await withTenantDb(async (tx) => {
    const [found] = await tx
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.publicId, publicId),
          eq(schema.invitations.orgId, ctx.orgId),
        ),
      )
      .for("update");
    if (!found)
      throw new HandlerError({
        code: "not_found",
        reason: "invitation_not_found",
      });
    if (found.status !== "pending")
      throw new HandlerError({ code: "conflict", reason: "invitation_closed" });
    const expiresAt =
      verb === "resend"
        ? new Date(now.getTime() + 7 * 86_400_000)
        : found.expiresAt;
    const status = verb === "resend" ? "pending" : "revoked";
    await tx
      .update(schema.invitations)
      .set({ status, expiresAt, updatedAt: now, updatedById: userId })
      .where(
        and(
          eq(schema.invitations.id, found.id),
          eq(schema.invitations.status, "pending"),
        ),
      );
    return { ...found, status, expiresAt };
  });
  let deliveryStatus: "accepted" | "failed" = "accepted";
  if (verb === "resend") {
    try {
      // tenancy: filtered by userId after authenticated Owner or Admin membership and an org-bound invitation update.
      const inviter = await withSystemDb((tx) =>
        tx.query.users.findFirst({
          where: eq(schema.users.id, userId),
          columns: { displayName: true },
        }),
      );
      const org = await withTenantDb((tx) =>
        tx.query.organizations.findFirst({
          where: eq(schema.organizations.id, ctx.orgId),
          columns: { name: true },
        }),
      );
      const delivery = await sendEmail({
        to: row.email,
        ...invitationEmailTemplate({
          inviteUrl: `${process.env.APP_URL ?? "https://app.oxagen.sh"}/invite/${row.publicId}`,
          inviterName: inviter?.displayName ?? "A team member",
          orgName: org?.name ?? ctx.orgId,
          role: row.role,
          email: row.email,
        }),
      });
      if (
        delivery.rejected.length > 0 ||
        !delivery.accepted.some(
          (address) => address.toLowerCase() === row.email.toLowerCase(),
        )
      )
        throw new Error("Invitation recipient was not accepted for delivery");
    } catch (error) {
      logger.warn(
        { err: error, orgId: ctx.orgId, invitationId: row.publicId },
        "Invitation email delivery failed",
      );
      deliveryStatus = "failed";
    }
  }
  return {
    invitationPublicId: row.publicId,
    status: row.status as V extends "resend" ? "pending" : "revoked",
    expiresAt: row.expiresAt?.toISOString() ?? null,
    ...(verb === "resend" ? { delivery: deliveryStatus } : {}),
  };
}
