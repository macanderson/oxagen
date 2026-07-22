// api.key.rotate.ts — handler for the api.key.rotate capability.
//
// Atomically (single transaction): verify the old key belongs to the org and is
// active, insert a replacement key inheriting its scope/workspace/expiry, and
// soft-delete the old key. The raw replacement is returned exactly once.
//
// Flow:
//   1. Auth + scope guard — authenticated principal + orgId.
//   2. Role gate — actor must be org Owner or Admin.
//   3. One transaction: load old (IDOR-safe) → insert new → soft-delete old.
//   4. Emit api_key.created + api_key.revoked security events (fire-and-forget).

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { apiKeyRotate } from "@oxagen/oxagen/contracts/api.key.rotate";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, isNull } from "drizzle-orm";
import { actorCanManageApiKeys, generateApiKey } from "./lib/api-key-authz";
import { requestsReservedStellaTelemetryPurpose } from "./lib/stella-telemetry-enrollment";
import { logger } from "./logger";

export const apiKeyRotateHandler: CapabilityHandler<
  typeof apiKeyRotate
> = async (input, ctx) => {
  // ── Auth + scope guard ─────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    throw new CapabilityError(
      "rotate_api_key",
      "authz_denied",
      "Unauthorized: no authenticated principal",
    );
  }
  if (!ctx.orgId) {
    throw new CapabilityError(
      "rotate_api_key",
      "authz_denied",
      "Forbidden: orgId is required",
    );
  }

  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";

  // ── Role gate ─────────────────────────────────────────────────────────────
  if (!(await actorCanManageApiKeys(ctx.orgId, actorId))) {
    logger.warn(
      { orgId: ctx.orgId, actorId },
      "api.key.rotate: rejected — insufficient org role",
    );
    throw new CapabilityError(
      "rotate_api_key",
      "authz_denied",
      "Forbidden: only org Owners and Admins can rotate API keys",
    );
  }

  const now = new Date();

  // ── Atomic rotate: load old → insert new → revoke old (one transaction) ────
  const result = await withTenantDb(async (tx) => {
    const [oldKey] = await tx
      .select({
        id: schema.apiKeys.id,
        publicId: schema.apiKeys.publicId,
        name: schema.apiKeys.name,
        scope: schema.apiKeys.scope,
        expiresAt: schema.apiKeys.expiresAt,
        workspaceId: schema.apiKeys.workspaceId,
      })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.publicId, input.keyPublicId),
          eq(schema.apiKeys.orgId, ctx.orgId),
          isNull(schema.apiKeys.deletedAt),
        ),
      )
      .limit(1);

    if (!oldKey) {
      throw new Error(
        "Not found: API key does not exist, is not in this org, or is already revoked",
      );
    }

    if (requestsReservedStellaTelemetryPurpose(oldKey.scope)) {
      logger.warn(
        { orgId: ctx.orgId, keyPublicId: oldKey.publicId },
        "api.key.rotate: rejected — reserved Stella telemetry purpose",
      );
      throw new CapabilityError(
        "rotate_api_key",
        "authz_denied",
        "Forbidden: enrolled Stella telemetry keys require operator rotation",
      );
    }

    const { rawKey, keyPrefix, keyHash } = generateApiKey();

    const [inserted] = await tx
      .insert(schema.apiKeys)
      .values({
        orgId: ctx.orgId,
        workspaceId: oldKey.workspaceId,
        keyPrefix,
        keyHash,
        name: input.name ?? oldKey.name,
        scope: oldKey.scope ?? {},
        ...(oldKey.expiresAt ? { expiresAt: oldKey.expiresAt } : {}),
        createdByUserId: ctx.userId ?? undefined,
        updatedByUserId: ctx.userId ?? undefined,
      })
      .returning({
        id: schema.apiKeys.id,
        publicId: schema.apiKeys.publicId,
        name: schema.apiKeys.name,
        keyPrefix: schema.apiKeys.keyPrefix,
        expiresAt: schema.apiKeys.expiresAt,
        createdAt: schema.apiKeys.createdAt,
      });

    if (!inserted) {
      throw new Error(
        "Internal error: failed to create replacement API key row",
      );
    }

    await tx
      .update(schema.apiKeys)
      .set({
        deletedAt: now,
        deletedByUserId: ctx.userId ?? undefined,
        updatedAt: now,
        updatedByUserId: ctx.userId ?? undefined,
      })
      .where(eq(schema.apiKeys.id, oldKey.id));

    return { inserted, rawKey, revokedPublicId: oldKey.publicId };
  });

  // ── Emit audit events (fire-and-forget) ────────────────────────────────────
  emitSecurityEvent({
    eventType: "api_key.created",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "rotate_api_key",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  emitSecurityEvent({
    eventType: "api_key.revoked",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "rotate_api_key",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorId,
      newKeyPublicId: result.inserted.publicId,
      revokedKeyPublicId: result.revokedPublicId,
      surface: ctx.surface,
    },
    "api.key.rotate: API key rotated",
  );

  return {
    keyId: result.inserted.id,
    publicId: result.inserted.publicId,
    name: result.inserted.name,
    keyPrefix: result.inserted.keyPrefix,
    rawKey: result.rawKey,
    expiresAt: result.inserted.expiresAt?.toISOString() ?? null,
    createdAt: result.inserted.createdAt.toISOString(),
    revokedKeyPublicId: result.revokedPublicId,
    revokedAt: now.toISOString(),
  };
};
