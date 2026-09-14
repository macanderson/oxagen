"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { emitSecurityEvent } from "@oxagen/database/security";
import { isSeatLimitError, assertSeatAvailable } from "@oxagen/billing";
import { sendEmail, invitationEmailTemplate } from "@oxagen/notifications";
import { requireEnv } from "@oxagen/config/env";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, getOrgRole } from "@/lib/resolve-org";
import { logger, maskEmail } from "@oxagen/handlers/logger";

// Roles permitted to invite members at all. A plain member cannot grow the org.
const INVITER_ROLES = new Set(["owner", "admin"]);
// Elevated roles only an owner may grant — prevents an admin from minting peers
// at or above their own privilege (privilege-escalation guard).
const OWNER_GRANTABLE_ROLES = new Set(["owner", "admin"]);

// Sentinel workspaceId for org-only actions (no workspace context).
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

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
  | { ok: false; code: "forbidden"; error: string }
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

  // Authorization gate. resolveOrg only maps slug→id; it is NOT a membership
  // check, and apps/app does not bootstrap IAM, so the invite must be gated
  // here. Without this, any authenticated user could POST an arbitrary orgSlug
  // + role:"owner" and mint an owner invitation in any org (cross-tenant IDOR +
  // privilege escalation). A non-member and a non-privileged member are treated
  // identically ("forbidden") so org existence is never confirmed to outsiders.
  const inviterRole = await getOrgRole(tenant.id, session.user.id);
  if (!inviterRole || !INVITER_ROLES.has(inviterRole)) {
    emitSecurityEvent({
      eventType: "org.member_invited",
      actorUserId: session.user.id,
      orgId: tenant.id,
      workspaceId: null,
      capability: "add_org_member",
      outcome: "deny",
      ip: null,
      userAgent: null,
      requestId: null,
    });
    return {
      ok: false,
      code: "forbidden",
      error:
        "You don't have permission to invite members to this organization.",
    };
  }
  // Only an owner may grant owner/admin — an admin cannot escalate a peer.
  if (OWNER_GRANTABLE_ROLES.has(role) && inviterRole !== "owner") {
    return {
      ok: false,
      code: "forbidden",
      error: "Only an owner can grant the owner or admin role.",
    };
  }

  try {
    // Assert a license is available before creating the invitation.
    // getOrgSeatUsage reads via withTenantDb, so the check needs the ambient
    // tenant scope (page.tsx wraps its seat read the same way) — without it
    // the query dies under FORCE RLS and every invite failed as "internal".
    await runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, () =>
      assertSeatAvailable(tenant.id),
    );
  } catch (err) {
    if (isSeatLimitError(err)) {
      return {
        ok: false,
        code: "seat_limit_reached",
        billingHref: `/${orgSlug}/billing/subscription`,
      };
    }
    logger.error({ err, orgSlug }, "members: seat check failed");
    return {
      ok: false,
      code: "internal",
      error: "Could not verify seat availability",
    };
  }

  return await runInTenantScope(
    { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
    async () => {
      try {
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const [inserted] = await withTenantDb((tx) =>
          tx
            .insert(schema.invitations)
            .values({
              orgId: tenant.id,
              email,
              role,
              status: "pending",
              invitedByUserId: session.user.id,
              expiresAt,
            })
            .returning({ publicId: schema.invitations.publicId }),
        );

        logger.info(
          { orgSlug, email: maskEmail(email), role },
          "members: invitation created",
        );

        // Emit org.member_invited audit event (fire-and-forget).
        emitSecurityEvent({
          eventType: "org.member_invited",
          actorUserId: session.user.id,
          orgId: tenant.id,
          workspaceId: null,
          capability: "add_org_member",
          outcome: "success",
          ip: null,
          userAgent: null,
          requestId: null,
        });

        // Send the transactional invitation email (non-fatal: sendEmail throws when
        // SMTP is unconfigured, e.g. local dev — the invite still succeeds).
        try {
          if (!inserted) throw new Error("invitation insert returned no row");
          const env = requireEnv(["NEXT_PUBLIC_APP_URL"] as const);
          const inviteUrl = `${env.NEXT_PUBLIC_APP_URL}/${orgSlug}/members/accept?invitation=${inserted.publicId}`;
          const inviterName = session.user.name ?? session.user.email;
          const { subject, text, html } = invitationEmailTemplate({
            inviteUrl,
            inviterName,
            orgName: tenant.name,
            role,
            email,
          });
          await sendEmail({ to: email, subject, text, html });
          logger.info(
            { orgSlug, email: maskEmail(email) },
            "members: invitation email sent",
          );
        } catch (emailErr) {
          logger.error(
            { err: emailErr, orgSlug, email: maskEmail(email) },
            "members: invitation email failed (non-fatal)",
          );
        }

        // Revalidate both routes: this action is called from the People page
        // (AddMemberDialog) AND from the Invited tab (PendingInvitationsActions
        // "Resend") — a mutation triggered from /members/pending must refresh
        // that page too, not just /members, or the currently-viewed list and
        // the layout's pending-count badge go stale until an unrelated nav.
        revalidatePath(`/${orgSlug}/members`);
        revalidatePath(`/${orgSlug}/members/pending`);
        return { ok: true };
      } catch (err) {
        // Unique violation on the partial index over (org_id, email) WHERE
        // status = 'pending'. The index is named "n" (see
        // packages/database/src/schema/org.ts), so Postgres reports
        // `duplicate key value violates unique constraint "n"` — match on the
        // stable "unique" substring rather than an index name.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("unique")) {
          return {
            ok: false,
            code: "already_invited",
            error: `${email} already has a pending invitation.`,
          };
        }
        logger.error(
          { err, orgSlug, email: maskEmail(email) },
          "members: inviteMemberAction failed",
        );
        return {
          ok: false,
          code: "internal",
          error: "Failed to create invitation",
        };
      }
    },
  );
}

// ── declineInvitationAction ───────────────────────────────────────────────────

export type InvitationActionResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Revoke a pending invitation (status → "declined").
 *
 * Both call sites (the People panel and the Invited tab) only render the
 * control for an owner/admin, but the UI is not the gate: this is a server
 * action, so it must gate itself. Without the role check any authenticated
 * user who learns an invitation's publicId could revoke invitations in any
 * org by passing that org's slug — apps/app does not bootstrap kernel IAM and
 * resolveOrg only maps slug→id.
 */
export async function declineInvitationAction(input: {
  orgSlug: string;
  invitationPublicId: string;
}): Promise<InvitationActionResult> {
  const session = await getSessionOrRedirect();
  const tenant = await resolveOrg(input.orgSlug);

  const actorRole = await getOrgRole(tenant.id, session.user.id);
  if (!actorRole || !INVITER_ROLES.has(actorRole)) {
    // A non-member and a non-privileged member get the same answer, so org
    // existence is never confirmed to an outsider (mirrors inviteMemberAction).
    return {
      ok: false,
      error:
        "You don't have permission to manage invitations for this organization.",
    };
  }

  return await runInTenantScope(
    { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
    async () => {
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
          return {
            ok: false,
            error: "Invitation not found or already resolved.",
          };
        }

        logger.info(
          {
            orgSlug: input.orgSlug,
            invitationPublicId: input.invitationPublicId,
          },
          "members: invitation declined",
        );
        // See the matching comment in inviteMemberAction: this action is also
        // called from the Invited tab (Revoke), which lives at a different
        // route than /members — both must be revalidated.
        revalidatePath(`/${input.orgSlug}/members`);
        revalidatePath(`/${input.orgSlug}/members/pending`);
        return { ok: true };
      } catch (err) {
        logger.error({ err }, "members: declineInvitationAction failed");
        return { ok: false, error: "Failed to decline invitation" };
      }
    },
  );
}
