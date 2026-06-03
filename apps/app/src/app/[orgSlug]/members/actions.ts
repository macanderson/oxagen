"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { db, schema } from "@oxagen/database";
import { isSeatLimitError, assertSeatAvailable } from "@oxagen/billing";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";

// ── Schemas ───────────────────────────────────────────────────────────────────

const InviteMemberSchema = z.object({
  orgSlug: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member", "billing"]),
});

// ── inviteMemberAction ────────────────────────────────────────────────────────

export type InviteMemberResult =
  | { ok: true }
  | { ok: false; code: "seat_limit_reached"; billingHref: string }
  | { ok: false; code: "validation_error"; error: string }
  | { ok: false; code: "already_invited"; error: string }
  | { ok: false; code: "internal"; error: string };

export async function inviteMemberAction(
  input: z.infer<typeof InviteMemberSchema>,
): Promise<InviteMemberResult> {
  const session = await getSessionOrRedirect();
  const parsed = InviteMemberSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "validation_error", error: "Invalid input" };
  }

  const { orgSlug, email, role } = parsed.data;
  const tenant = await resolveOrg(orgSlug);

  try {
    // Assert a license is available before creating the invitation.
    await assertSeatAvailable(tenant.id);
  } catch (err) {
    if (isSeatLimitError(err)) {
      return {
        ok: false,
        code: "seat_limit_reached",
        billingHref: `/${orgSlug}/billing/subscription`,
      };
    }
    logger.error({ err, orgSlug }, "members: seat check failed");
    return { ok: false, code: "internal", error: "Could not verify seat availability" };
  }

  try {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await db()
      .insert(schema.invitations)
      .values({
        orgId: tenant.id,
        email,
        role,
        status: "pending",
        invitedByUserId: session.user.id,
        expiresAt,
      });

    logger.info({ orgSlug, email, role }, "members: invitation created");
    revalidatePath(`/${orgSlug}/members`);
    return { ok: true };
  } catch (err) {
    // Unique violation on (orgId, email) for pending invitations.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("invitations_org_email_pending_idx") || msg.includes("unique")) {
      return { ok: false, code: "already_invited", error: `${email} already has a pending invitation.` };
    }
    logger.error({ err, orgSlug, email }, "members: inviteMemberAction failed");
    return { ok: false, code: "internal", error: "Failed to create invitation" };
  }
}

// ── declineInvitationAction ───────────────────────────────────────────────────

export type InvitationActionResult = { ok: true } | { ok: false; error: string };

export async function declineInvitationAction(input: {
  orgSlug: string;
  invitationPublicId: string;
}): Promise<InvitationActionResult> {
  await getSessionOrRedirect();
  const tenant = await resolveOrg(input.orgSlug);

  try {
    const updated = await db()
      .update(schema.invitations)
      .set({ status: "declined", updatedAt: new Date() })
      .where(
        and(
          eq(schema.invitations.orgId, tenant.id),
          eq(schema.invitations.publicId, input.invitationPublicId),
          eq(schema.invitations.status, "pending"),
        ),
      )
      .returning({ id: schema.invitations.id });

    if (updated.length === 0) {
      return { ok: false, error: "Invitation not found or already resolved." };
    }

    logger.info(
      { orgSlug: input.orgSlug, invitationPublicId: input.invitationPublicId },
      "members: invitation declined",
    );
    revalidatePath(`/${input.orgSlug}/members`);
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "members: declineInvitationAction failed");
    return { ok: false, error: "Failed to decline invitation" };
  }
}
