import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoEnrollmentRevoke } from "@oxagen/oxagen/contracts/tacho.enrollment.revoke";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  noOperatorMessage,
  resolveActorOrgRole as resolveActorRole,
  resolveOperatorUserId,
} from "./lib/api-key-authz";
import { revokeHostEnrollment } from "./lib/tacho-host-revoke";
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
  if (!ctx.orgId) throw denied("Forbidden: orgId is required");
  // `tacho unenroll` and a harness change revoke with the `oxagen login` key;
  // a host's own machine-bound key never acts for a person.
  const operatorUserId = await resolveOperatorUserId(ctx);
  if (!operatorUserId) throw denied(noOperatorMessage(ctx));
  const actorRole = await resolveActorRole(ctx.orgId, operatorUserId);
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
    await revokeHostEnrollment(tx, host, {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: operatorUserId,
      reason: input.reason ?? null,
      now,
    });
    return { revokedAt: now, already: false };
  });

  if (!result.already) {
    emitSecurityEvent({
      eventType: "api_key.revoked",
      actorUserId: operatorUserId,
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
