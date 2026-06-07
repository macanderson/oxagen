// api.key.revoke.ts — handler for the api.key.revoke capability.
//
// Flow:
//   1. Auth + scope guard — require authenticated principal + orgId.
//   2. Role gate — actor must hold Owner or Admin in the org.
//   3. Resolve the key by publicId within ctx.orgId (IDOR guard: 404 if the
//      key does not belong to this org, or if it is already revoked).
//   4. Soft-delete: set deletedAt = now(), deletedByUserId = actorId.
//   5. Emit api_key.revoked security event (fire-and-forget).

import type { CapabilityHandler } from "@oxagen/oxagen";
import { apiKeyRevoke } from "@oxagen/oxagen/contracts/api.key.revoke";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

const AUTHORIZED_ROLES = new Set(["Owner", "Admin"]);

async function resolveActorRole(orgId: string, userId: string): Promise<string | null> {
  return withTenantDb(async (tx) => {
    const [principalRow] = await tx
      .select({ id: schema.principals.id })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, orgId),
          eq(schema.principals.parentUserId, userId),
          eq(schema.principals.status, "active"),
        ),
      )
      .limit(1);

    if (!principalRow) return null;

    const [praRow] = await tx
      .select({ roleName: schema.roles.name })
      .from(schema.principalRoleAssignments)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.principalRoleAssignments.roleId))
      .where(
        and(
          eq(schema.principalRoleAssignments.principalId, principalRow.id),
          eq(schema.principalRoleAssignments.orgId, orgId),
          eq(schema.roles.scopeKind, "org"),
          isNull(schema.principalRoleAssignments.workspaceId),
          isNull(schema.principalRoleAssignments.deletedAt),
        ),
      )
      .limit(1);

    return praRow?.roleName ?? null;
  });
}

export const apiKeyRevokeHandler: CapabilityHandler<typeof apiKeyRevoke> = async (input, ctx) => {
  // ── Auth + scope guard ─────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn({ orgId: ctx.orgId }, "api.key.revoke: rejected — no authenticated principal");
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId) {
    logger.warn({}, "api.key.revoke: rejected — missing orgId");
    throw new Error("Forbidden: orgId is required");
  }

  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";

  // ── Role gate ─────────────────────────────────────────────────────────────
  const actorRole = await resolveActorRole(ctx.orgId, actorId);
  if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
    logger.warn(
      { orgId: ctx.orgId, actorId, actorRole },
      "api.key.revoke: rejected — insufficient org role",
    );
    throw new Error("Forbidden: only org Owners and Admins can revoke API keys");
  }

  const revokedAt = new Date();

  // ── Soft-delete (IDOR-safe: must match orgId) ─────────────────────────────
  await withTenantDb(async (tx) => {
    // Verify the key belongs to this org and is not already revoked.
    const [existing] = await tx
      .select({ id: schema.apiKeys.id, publicId: schema.apiKeys.publicId })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.publicId, input.keyPublicId),
          eq(schema.apiKeys.orgId, ctx.orgId),
          isNull(schema.apiKeys.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      logger.warn(
        { orgId: ctx.orgId, keyPublicId: input.keyPublicId },
        "api.key.revoke: key not found or already revoked",
      );
      throw new Error("Not found: API key does not exist, is not in this org, or is already revoked");
    }

    await tx
      .update(schema.apiKeys)
      .set({
        deletedAt: revokedAt,
        deletedByUserId: ctx.userId ?? undefined,
        updatedAt: revokedAt,
        updatedByUserId: ctx.userId ?? undefined,
      })
      .where(eq(schema.apiKeys.id, existing.id));
  });

  // ── Emit audit event (fire-and-forget) ────────────────────────────────────
  emitSecurityEvent({
    eventType: "api_key.revoked",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "api.key.revoke",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorId,
      keyPublicId: input.keyPublicId,
      surface: ctx.surface,
    },
    "api.key.revoke: API key revoked",
  );

  return {
    revoked: true,
    keyPublicId: input.keyPublicId,
    revokedAt: revokedAt.toISOString(),
  };
};
