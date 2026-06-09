import type { CapabilityHandler } from "@oxagen/oxagen";
import { privacyDataErase } from "@oxagen/oxagen/contracts/privacy.data.erase";
import { withSystemDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { inngest } from "@oxagen/inngest-functions/client";
import { emitSecurityEvent } from "@oxagen/database/security";
import { logger } from "./logger";

function generatePublicId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 22; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

/**
 * Grace period before hard-delete executes.
 * Default: 30 days.
 * Set PRIVACY_ERASURE_GRACE_DAYS=0 for immediate erasure (test envs).
 */
function getGracePeriodMs(): number {
  const days = parseInt(process.env.PRIVACY_ERASURE_GRACE_DAYS ?? "30", 10);
  return Math.max(0, days) * 24 * 60 * 60 * 1000;
}

export const privacyDataEraseHandler: CapabilityHandler<
  typeof privacyDataErase
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new Error("Unauthorized: authentication required to request data erasure");
  }
  if (!ctx.orgId) {
    throw new Error("Forbidden: orgId is required");
  }

  if (input.scope === "org") {
    if (!input.orgId) throw new Error("orgId is required for org-scope erasure");
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
    const role = membership[0]?.role;
    if (role !== "Owner") {
      throw new Error("Forbidden: org erasure requires Owner role");
    }
  }

  const orgId = input.scope === "org" ? (input.orgId ?? ctx.orgId) : ctx.orgId;
  const scheduledAt = new Date(Date.now() + getGracePeriodMs());

  const [row] = await withSystemDb((tx) =>
    tx
      .insert(schema.privacyErasureRequests)
      .values({
        publicId: generatePublicId("preras"),
        userId: ctx.userId!,
        orgId,
        scope: input.scope,
        status: "queued",
        scheduledAt,
      })
      .returning({ id: schema.privacyErasureRequests.id }),
  );

  if (!row) throw new Error("Failed to create erasure request");

  // Immediately revoke all active sessions for this user
  await withSystemDb((tx) =>
    tx.delete(schema.sessions).where(eq(schema.sessions.userId, ctx.userId!)),
  );

  const eventType = (
    input.scope === "org" ? "privacy.org_erasure_requested" : "privacy.erasure_requested"
  ) as "privacy.org_erasure_requested" | "privacy.erasure_requested";

  emitSecurityEvent({
    eventType,
    actorUserId: ctx.userId,
    orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "privacy.data.erase",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  // Dispatch async Inngest job for actual data deletion on scheduledAt
  await inngest.send({
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
