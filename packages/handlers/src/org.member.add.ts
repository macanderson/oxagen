// org.member.add.ts — handler for the org.member.add capability.
//
// Flow:
//   1. Auth guard — require authenticated principal + orgId.
//   2. Role guard — the caller must be an Owner or Admin of ctx.orgId.
//   3. assertSeatAvailable — throws SeatLimitError when org is at capacity.
//   4. Insert a pending invitation (idempotent: the partial unique index on
//      (orgId, email) WHERE status='pending' prevents duplicate active invites).
//   5. Return the invitation shape expected by the contract.
//
// A pending invitation occupies a seat. The seat is released when the user
// declines (or when an admin revokes) the invitation.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgMemberAdd } from "@oxagen/oxagen/contracts/org.member.add";
import {
  schema,
  withTenantDb,
  withSystemDb,
  isUniqueViolation,
} from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertSeatAvailable, isSeatLimitError } from "@oxagen/billing";
import { logger, maskEmail } from "./logger";

// 30-day invitation TTL.
const INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const orgMemberAddHandler: CapabilityHandler<
  typeof orgMemberAdd
> = async (input, ctx) => {
  // ── Auth guard ───────────────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      { orgId: ctx.orgId },
      "org.member.add: rejected — no authenticated principal",
    );
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId) {
    logger.warn({}, "org.member.add: rejected — missing orgId");
    throw new Error("Forbidden: orgId is required to invite a member");
  }

  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";

  // ── Role guard ───────────────────────────────────────────────────────────────
  // The contract's defaultRoles restrict this to org Owner and Admin, and the
  // kernel's IAM gate is where that is meant to be enforced. It is not enough on
  // its own: the gate consults no policy for an org below the tier that unlocks
  // ACLs, so on every other tier this capability was reachable by any member.
  // `role` is a free string on the wire, so a member could invite an accomplice
  // — or their own second address — as "owner" and take the org.
  //
  // Re-read the caller's membership here, the way privacy.data.export does.
  // Defence in depth: this holds whatever the tier gate decides.
  //
  // Lowercased because org_users.role is written in both casings — see
  // privacy.data.erase for the same normalisation and the reason.
  if (ctx.userId) {
    const membership = await withSystemDb((tx) =>
      tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, ctx.orgId!),
            eq(schema.orgUsers.userId, ctx.userId!),
          ),
        )
        .limit(1),
    );
    const role = membership[0]?.role?.toLowerCase();
    if (role !== "owner" && role !== "admin") {
      logger.warn(
        { orgId: ctx.orgId, actorId, role: role ?? null },
        "org.member.add: rejected — caller is not an org Owner or Admin",
      );
      throw new Error("Forbidden: inviting a member requires Owner or Admin");
    }
  }

  // ── Seat enforcement ─────────────────────────────────────────────────────────
  try {
    await assertSeatAvailable(ctx.orgId);
  } catch (err) {
    if (isSeatLimitError(err)) {
      logger.warn(
        { orgId: ctx.orgId, licenses: err.licenses, used: err.used },
        "org.member.add: seat limit reached",
      );
      // Re-throw as-is — the typed error lets the API/MCP layer surface a
      // 402 / structured MCP error with code:"seat_limit_reached".
      throw err;
    }
    throw err;
  }

  // ── Create pending invitation ────────────────────────────────────────────────
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  // The partial unique index on (org_id, email) WHERE status='pending' makes
  // this idempotent: a second invite to the same email fails at the DB level.
  // We surface that as a friendly duplicate-invite error rather than a 500.
  let invitation: { publicId: string; expiresAt: Date | null };

  try {
    const [row] = await withTenantDb((tx) =>
      tx
        .insert(schema.invitations)
        .values({
          orgId: ctx.orgId,
          email: input.email,
          role: input.role,
          status: "pending",
          invitedByUserId: actorId,
          expiresAt,
          createdByUserId: actorId,
          updatedByUserId: actorId,
        })
        .returning({
          publicId: schema.invitations.publicId,
          expiresAt: schema.invitations.expiresAt,
        }),
    );

    if (!row) throw new Error("invitation insert returned no row");
    invitation = row;
  } catch (err) {
    // Unique violation (code 23505) → duplicate pending invite. isUniqueViolation
    // walks the drizzle cause chain (the SQLSTATE is on .cause.code, not top-level).
    if (isUniqueViolation(err)) {
      logger.warn(
        { orgId: ctx.orgId, email: maskEmail(input.email) },
        "org.member.add: duplicate pending invitation for this email",
      );
      throw new Error(
        `A pending invitation for ${input.email} already exists in this org. Revoke or wait for it to expire before resending.`,
      );
    }
    logger.error(
      { err, orgId: ctx.orgId, email: maskEmail(input.email) },
      "org.member.add: invitation insert failed",
    );
    throw err;
  }

  logger.info(
    {
      orgId: ctx.orgId,
      email: maskEmail(input.email),
      role: input.role,
      invitationId: invitation.publicId,
      surface: ctx.surface,
    },
    "org.member.add: invitation created",
  );

  // Emit org.member_invited security event (fire-and-forget; must not fail the
  // capability — an audit write failure is non-blocking per SOC2 design).
  emitSecurityEvent({
    eventType: "org.member_invited",
    actorUserId: actorId,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "add_org_member",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  return {
    invitationId: invitation.publicId,
    email: input.email,
    role: input.role,
    status: "pending" as const,
    expiresAt: invitation.expiresAt ? invitation.expiresAt.toISOString() : null,
  };
};
