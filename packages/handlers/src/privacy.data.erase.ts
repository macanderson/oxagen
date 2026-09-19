import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { privacyDataErase } from "@oxagen/oxagen/contracts/privacy.data.erase";
import { withSystemDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { orgMembershipRole } from "./_org_membership";
import { assertCapabilityNotRevoked } from "./lib/capability-policy-recheck";
import { eventClient } from "./event-client";
import { emitSecurityEvent } from "@oxagen/database/security";
import { logger } from "./logger";

// CSPRNG-backed, matching the idMixin public-id default (@oxagen/database
// schema/_mixins.ts) rather than hand-rolling a weaker Math.random() generator.
function generatePublicId(prefix: string): string {
  return `${prefix}_${schema.cryptoRandom(22)}`;
}

const DEFAULT_GRACE_DAYS = 30;

/**
 * Grace period before hard-delete executes.
 * Default: 30 days.
 * Set PRIVACY_ERASURE_GRACE_DAYS=0 for immediate erasure (test envs).
 *
 * A missing or unparseable value falls back to the 30-day default rather than
 * producing NaN — an NaN grace period would make `scheduledAt` an Invalid Date
 * and fail the erasure-request insert, silently blocking a GDPR request.
 */
function getGracePeriodMs(): number {
  const raw = process.env.PRIVACY_ERASURE_GRACE_DAYS;
  const parsed =
    raw === undefined ? DEFAULT_GRACE_DAYS : Number.parseInt(raw, 10);
  const days = Number.isFinite(parsed)
    ? Math.max(0, parsed)
    : DEFAULT_GRACE_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

export const privacyDataEraseHandler: CapabilityHandler<
  typeof privacyDataErase
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new Error(
      "Unauthorized: authentication required to request data erasure",
    );
  }
  if (!ctx.orgId) {
    throw new Error("Forbidden: orgId is required");
  }

  if (input.scope === "org") {
    if (!input.orgId)
      throw new Error("orgId is required for org-scope erasure");
    // The erasure target must be the org the kernel governed.
    //
    // `invoke()` resolves IAM against `ctx.orgId`, and the recheck below asks
    // the resolver in that same context. A body-supplied `orgId` naming a
    // DIFFERENT org would have every decision made in one tenant and every
    // record hard-deleted from another: the target org's grants, including an
    // explicit `erase_data` deny, are never read, so an owner of both orgs
    // could schedule the irreversible deletion of the denying one by invoking
    // through the other. The membership read below cannot close that; it cannot
    // see a deny grant at all.
    //
    // Same rule and same wording as privacy.data.export, which already
    // required it: two ids that must agree are better made equal than kept in
    // step. A caller who wants another org erased invokes in that org's own
    // context, where the kernel governs it.
    if (input.orgId !== ctx.orgId) {
      throw new HandlerError({
        code: "forbidden",
        reason: "org_erasure_outside_governed_scope",
        message:
          "An organization erasure must be requested in that organization's own context, so its access rules govern the request",
      });
    }
    // Org-scope erasure: Owner only (enforced by IAM + explicit check here for
    // defense-in-depth). Owner alone, not Owner or Admin: erasing an
    // organization's data is not the same authority as exporting it.
    const role = await orgMembershipRole(input.orgId, ctx.userId);
    if (role !== "owner") {
      throw new Error("Forbidden: org erasure requires owner role");
    }
    // The role is one revocation path; an explicit `deny` written against
    // `erase_data` itself is the other, and `org_users.role` cannot see it. The
    // kernel does not see it either below the enterprise tier, where its gate
    // answers `tier_gate → allow` before any policy is read. So an owner of an
    // organisation that had explicitly denied erasure could still schedule the
    // hard-delete of every record in it. Same guard as the export paths, same
    // reason: an explicit deny that does not deny is worse than no control at
    // all, because whoever wrote it believes the action is impossible.
    await assertCapabilityNotRevoked(privacyDataErase, ctx, {
      reason: "org_erasure_not_permitted",
      message:
        "An organization erasure is not permitted: the erase_data policy for this organization denies it",
    });
  }

  const orgId = input.scope === "org" ? (input.orgId ?? ctx.orgId) : ctx.orgId;
  const scheduledAt = new Date(Date.now() + getGracePeriodMs());

  // Persist the erasure request AND revoke all active sessions atomically in a
  // single transaction. If these ran as two separate withSystemDb calls, a crash
  // between them could record the request (blocking re-request) while leaving
  // sessions active — violating the GDPR requirement to revoke access on erasure.
  const row = await withSystemDb(async (tx) => {
    const [inserted] = await tx
      .insert(schema.privacyErasureRequests)
      .values({
        publicId: generatePublicId("preras"),
        userId: ctx.userId!,
        orgId,
        scope: input.scope,
        status: "queued",
        scheduledAt,
      })
      .returning({ id: schema.privacyErasureRequests.id });

    if (!inserted) throw new Error("Failed to create erasure request");

    // Immediately revoke all active sessions for this user.
    await tx
      .delete(schema.sessions)
      .where(eq(schema.sessions.userId, ctx.userId!));

    return inserted;
  });

  const eventType = (
    input.scope === "org"
      ? "privacy.org_erasure_requested"
      : "privacy.erasure_requested"
  ) as "privacy.org_erasure_requested" | "privacy.erasure_requested";

  emitSecurityEvent({
    eventType,
    actorUserId: ctx.userId,
    orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "erase_data",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  // Dispatch async Inngest job for actual data deletion on scheduledAt
  await eventClient.send({
    name: "privacy/erasure.execute",
    data: {
      requestId: row.id,
      userId: ctx.userId!,
      orgId,
      scope: input.scope,
      scheduledAt: scheduledAt.toISOString(),
    },
  });

  logger.info(
    { requestId: row.id, scope: input.scope, orgId, scheduledAt },
    "privacy.data.erase: queued",
  );

  return {
    requestId: row.id,
    status: "queued" as const,
    effectiveAt: scheduledAt.toISOString(),
  };
};
