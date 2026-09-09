import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoEnrollmentRevoke } from "@oxagen/oxagen/contracts/tacho.enrollment.revoke";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  resolveActorOrgRole as resolveActorRole,
} from "./lib/api-key-authz";
import { logger } from "./logger";

function denied(message: string): CapabilityError {
  return new CapabilityError(
    "revoke_tacho_enrollment",
    "authz_denied",
    message,
  );
}

/**
 * Revoke a host: retire its key, mark it revoked, and queue a `revoke`
 * command so a collector mid-poll learns immediately rather than at its next
 * bundle refresh. Idempotent: revoking a revoked host answers the same.
 */
export const tachoEnrollmentRevokeHandler: CapabilityHandler<
  typeof tachoEnrollmentRevoke
> = async (input, ctx) => {
  if (!ctx.userId) throw denied("Unauthorized: no authenticated user");
  if (!ctx.orgId) throw denied("Forbidden: orgId is required");
  const actorRole = await resolveActorRole(ctx.orgId, ctx.userId);
  if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
    throw denied(
      "Forbidden: only org Owners and Admins can revoke Tacho hosts",
    );
  }

  const now = new Date();
  const result = await withTenantDb(async (tx) => {
    const host = await tx.query.tachoHosts.findFirst({
      where: and(
        eq(schema.tachoHosts.publicId, input.hostEnrollmentId),
        eq(schema.tachoHosts.orgId, ctx.orgId),
      ),
    });
    if (!host) {
      throw denied("Forbidden: unknown Tacho host");
    }
    if (host.status === "revoked" && host.revokedAt) {
      return { revokedAt: host.revokedAt, already: true };
    }
    await tx
      .update(schema.tachoHosts)
      .set({
        status: "revoked",
        revokedAt: now,
        revokeReason: input.reason ?? null,
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(eq(schema.tachoHosts.id, host.id));
    await tx
      .update(schema.apiKeys)
      .set({
        deletedAt: now,
        deletedByUserId: ctx.userId,
        updatedAt: now,
        updatedByUserId: ctx.userId,
      })
      .where(eq(schema.apiKeys.id, host.apiKeyId));
    await tx.insert(schema.tachoControlCommands).values({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      hostId: host.id,
      command: "revoke",
      payload: { reason: input.reason ?? "revoked by operator" },
      issuedByUserId: ctx.userId,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      createdByUserId: ctx.userId,
      updatedByUserId: ctx.userId,
    });
    return { revokedAt: now, already: false };
  });

  if (!result.already) {
    emitSecurityEvent({
      eventType: "api_key.revoked",
      actorUserId: ctx.userId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: "revoke_tacho_enrollment",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
    logger.info(
      { orgId: ctx.orgId, hostEnrollmentId: input.hostEnrollmentId },
      "tacho.enrollment.revoke: host revoked",
    );
  }
  return {
    hostEnrollmentId: input.hostEnrollmentId,
    status: "revoked",
    revokedAt: result.revokedAt.toISOString(),
  };
};
