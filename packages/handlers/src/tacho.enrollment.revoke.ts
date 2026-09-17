import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoEnrollmentRevoke } from "@oxagen/oxagen/contracts/tacho.enrollment.revoke";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  noOperatorMessage,
  resolveActorOrgRole as resolveActorRole,
  resolveOperatorUserId,
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
 * Revoke a host: retire its keys, mark it revoked, and queue a `revoke`
 * command so a collector mid-poll learns immediately rather than at its next
 * bundle refresh. Idempotent: revoking a revoked host answers the same.
 *
 * ## Why the keys are found by scope rather than by column
 *
 * Enrollment mints two credentials (ADR-078): the host's control-plane key,
 * whose id `tacho_hosts.api_key_id` carries, and a second key for the local MCP
 * gateway, whose id is carried nowhere. Revoking only `api_key_id` therefore
 * left the gateway key valid until it expired, so an operator who revoked a
 * lost or copied host had not actually taken the connected app's authority
 * away — it could keep invoking its read-only MCP mandate.
 *
 * Both keys record `scope.host_enrollment_id`, which enrollment writes and
 * nothing else uses as an identifier, so the enrollment is the thing every key
 * of the host has in common. Revoking by that predicate retires the pair in the
 * same transaction and, unlike a second column, cannot be half-populated for a
 * host enrolled before this change or miss a third credential added later.
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
    await tx
      .update(schema.tachoHosts)
      .set({
        status: "revoked",
        revokedAt: now,
        revokeReason: input.reason ?? null,
        updatedAt: now,
        updatedByUserId: operatorUserId,
      })
      .where(eq(schema.tachoHosts.id, host.id));
    // Every live key minted for this enrollment: the control-plane key and the
    // MCP gateway key, and anything a later enrollment adds beside them.
    const retired = await tx
      .update(schema.apiKeys)
      .set({
        deletedAt: now,
        deletedByUserId: operatorUserId,
        updatedAt: now,
        updatedByUserId: operatorUserId,
      })
      .where(
        and(
          eq(schema.apiKeys.orgId, ctx.orgId),
          isNull(schema.apiKeys.deletedAt),
          sql`${schema.apiKeys.scope} ->> 'host_enrollment_id' = ${host.publicId}`,
        ),
      )
      .returning({ id: schema.apiKeys.id });
    // The control-plane key is the one credential this host provably has, so
    // its absence from the scope sweep means the row predates the scope marker.
    // Retire it by id rather than leaving a live key behind.
    if (!retired.some((k) => k.id === host.apiKeyId)) {
      await tx
        .update(schema.apiKeys)
        .set({
          deletedAt: now,
          deletedByUserId: operatorUserId,
          updatedAt: now,
          updatedByUserId: operatorUserId,
        })
        .where(
          and(
            eq(schema.apiKeys.id, host.apiKeyId),
            isNull(schema.apiKeys.deletedAt),
          ),
        );
    }
    await tx.insert(schema.tachoControlCommands).values({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      hostId: host.id,
      command: "revoke",
      payload: { reason: input.reason ?? "revoked by operator" },
      issuedByUserId: operatorUserId,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      createdByUserId: operatorUserId,
      updatedByUserId: operatorUserId,
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
