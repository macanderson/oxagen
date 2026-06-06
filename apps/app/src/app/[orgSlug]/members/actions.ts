"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { recordSecurityEvent } from "@oxagen/telemetry";
import { isSeatLimitError, assertSeatAvailable } from "@oxagen/billing";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";

// Sentinel workspaceId for org-only actions (no workspace context). — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

// Email is PII (SOC 2 CC6 / GDPR data minimization) — never emit a raw address to
// the log aggregator. Mask the local part, keep the domain so logs stay useful for
// triage (`j***@acme.com`). The audit trail records the actor by userId, not email.
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local[0] ?? "";
  return `${head}***@${domain}`;
}

// Lazy singleton: build the audit inserter on first use. On the tenancy branch
// makeSecurityEventInserter() resolves its own db handle (withSystemDb for the
// no-scope audit write), so it takes no argument here.
let _auditInsert: ReturnType<typeof makeSecurityEventInserter> | null = null;
function auditInsert() {
  if (!_auditInsert) _auditInsert = makeSecurityEventInserter();
  return _auditInsert;
}

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

  return await runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, async () => {
    try {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      await withTenantDb((tx) =>
        tx
          .insert(schema.invitations)
          .values({
            orgId: tenant.id,
            email,
            role,
            status: "pending",
            invitedByUserId: session.user.id,
            expiresAt,
          }),
      );

      logger.info({ orgSlug, email: maskEmail(email), role }, "members: invitation created");

      // Emit org.member_invited audit event (fire-and-forget).
      recordSecurityEvent(auditInsert(), {
        eventType: "org.member_invited",
        actorUserId: session.user.id,
        orgId: tenant.id,
        workspaceId: null,
        capability: "org.member.add",
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: null,
      });

      revalidatePath(`/${orgSlug}/members`);
      return { ok: true };
    } catch (err) {
      // Unique violation on (orgId, email) for pending invitations.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("invitations_org_email_pending_idx") || msg.includes("unique")) {
        return { ok: false, code: "already_invited", error: `${email} already has a pending invitation.` };
      }
      logger.error({ err, orgSlug, email: maskEmail(email) }, "members: inviteMemberAction failed");
      return { ok: false, code: "internal", error: "Failed to create invitation" };
    }
  });
}

// ── declineInvitationAction ───────────────────────────────────────────────────

export type InvitationActionResult = { ok: true } | { ok: false; error: string };

export async function declineInvitationAction(input: {
  orgSlug: string;
  invitationPublicId: string;
}): Promise<InvitationActionResult> {
  await getSessionOrRedirect();
  const tenant = await resolveOrg(input.orgSlug);

  return await runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, async () => {
    try {
      const updated = await withTenantDb((tx) =>
        tx
          .update(schema.invitations)
          .set({ status: "declined", updatedAt: new Date() })
          .where(
            and(
              eq(schema.invitations.orgId, tenant.id),
              eq(schema.invitations.publicId, input.invitationPublicId),
              eq(schema.invitations.status, "pending"),
            ),
          )
          .returning({ id: schema.invitations.id }),
      );

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
  });
}
