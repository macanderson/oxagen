import type { CapabilityHandler } from "@oxagen/oxagen";
import { privacyDataErase } from "@oxagen/oxagen/contracts/privacy.data.erase";
import { withSystemDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
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
    // Org-scope erasure: Owner only (enforced by IAM + explicit check here for defense-in-depth)
    const membership = await withSystemDb((tx) =>
      tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, input.orgId!),
            eq(schema.orgUsers.userId, ctx.userId!),
          ),
        )
        .limit(1),
    );
    // org_users.role stores the lowercase membership role ("owner" | "admin" |
    // "member" — see seed.ts / organization.create.ts / the invite contract enum).
    // Compare against the lowercase value, NOT the capitalized SystemOrgRole
    // ("Owner") used by the IAM defaultRoles layer — those are different concepts.
    const role = membership[0]?.role;
    if (role !== "owner") {
      throw new Error("Forbidden: org erasure requires owner role");
    }
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
