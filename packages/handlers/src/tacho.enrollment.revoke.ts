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
import {
  retireEnrollmentKeys,
  revokeHostEnrollment,
} from "./lib/tacho-host-revoke";
import { hostReadColumns } from "./lib/tacho-gateway-columns";
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
      // Revoking a host has nothing to do with the gateway tier, and must not
      // start failing because the column it never reads is not there yet.
      columns: await hostReadColumns(tx),
    });
    if (!host) {
      throw denied("Forbidden: unknown Tacho host");
    }
    if (host.status === "revoked" && host.revokedAt) {
      // Still sweep the keys. A host revoked BEFORE the sweep existed had only
      // its `api_key_id` deleted, so its gateway key is live until it expires —
      // and that is exactly the population the sweep was written for. Returning
      // early here skipped precisely them.
      //
      // Nothing else about this path repeats: no host update, no queued
      // command, and the answer carries the ORIGINAL revocation instant,
      // because the host was revoked when it was revoked.
      const retiredCount = await retireEnrollmentKeys(tx, host, {
        orgId: ctx.orgId,
        userId: operatorUserId,
        now,
      });
      return { revokedAt: host.revokedAt, already: true, retiredCount };
    }
    await revokeHostEnrollment(tx, host, {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: operatorUserId,
      reason: input.reason ?? null,
      now,
    });
    return { revokedAt: now, already: false, retiredCount: null };
  });

  // A first revocation is always worth an audit event. A repeat is worth one
  // only when it actually took a credential away — which by definition the
  // first revocation did not, so it is a new fact rather than a duplicate.
  if (!result.already || (result.retiredCount ?? 0) > 0) {
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
      {
        orgId: ctx.orgId,
        hostEnrollmentId: input.hostEnrollmentId,
        already: result.already,
        retiredCount: result.retiredCount,
      },
      result.already
        ? "tacho.enrollment.revoke: retired keys an earlier revocation left live"
        : "tacho.enrollment.revoke: host revoked",
    );
  }
  return {
    hostEnrollmentId: input.hostEnrollmentId,
    status: "revoked",
    revokedAt: result.revokedAt.toISOString(),
  };
};
