// api.key.rotate.ts — handler for the api.key.rotate capability.
//
// Atomically (single transaction): verify the old key belongs to the org and is
// active, insert a replacement key inheriting its scope/workspace/expiry, and
// soft-delete the old key. The raw replacement is returned exactly once.
//
// Flow:
//   1. Auth + scope guard — authenticated principal + orgId.
//   2. Role gate — actor must be org Owner or Admin.
//   3. One transaction: load old (IDOR-safe) → refuse an archived workspace →
//      insert new → soft-delete old.
//   4. Emit api_key.created + api_key.revoked security events (fire-and-forget).

import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { apiKeyRotate } from "@oxagen/oxagen/contracts/api.key.rotate";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, isNull } from "drizzle-orm";
import { actorCanManageApiKeys, generateApiKey } from "./lib/api-key-authz";
import { rotationRefusalFor } from "./lib/api-key-rotatable";
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
        // Null by construction: the where filters `deleted_at IS NULL`. Passed
        // so the predicate answers over the whole row rather than a subset of
        // it, and so the revoked case cannot be forgotten if that filter moves.
        revokedAt: schema.apiKeys.deletedAt,
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
      throw new HandlerError({
        code: "not_found",
        reason: "api_key_not_found",
        message:
          "Not found: API key does not exist, is not in this org, or is already revoked",
      });
    }

    // The whole answer to "may this key be rotated" (lib/api-key-rotatable.ts),
    // which list_api_keys reads too so its `rotatable` and this refusal cannot
    // disagree. This is the enforcement: the app, the API and MCP all arrive
    // here, and a page's own check is a courtesy that can be stale.
    const refusal = rotationRefusalFor(oldKey, Date.now());
    if (refusal) {
      logger.warn(
        { orgId: ctx.orgId, keyPublicId: oldKey.publicId },
        refusal.log,
      );
      if (refusal.kind === "denied") {
        throw new CapabilityError(
          "rotate_api_key",
          "authz_denied",
          refusal.denial,
        );
      }
      throw new HandlerError({
        code: refusal.kind,
        reason: refusal.reason,
        message: refusal.message,
      });
    }

    // An archived workspace is meant to be inert, and what archival should
    // prevent is fresh secret material being issued for it. A rotation mints a
    // new key with a new secret, so it is that act whatever the expiry — the
    // replacement inheriting the rotated key's `expiresAt` shortens the tail
    // but does not change what happened. `create_api_key` refuses the same way
    // and for the same reason; the two read side by side deliberately.
    //
    // This does NOT close the access hole. The key being rotated still
    // authenticates into the archived workspace — `resolveApiKey` never
    // consults archival (#3123) — so this stops new material being minted and
    // revokes nothing already live. `revoke_api_key` has no archival check and
    // must not acquire one: revoking is the path that actually helps an
    // operator with a compromised key in an archived workspace.
    //
    // Read in this same transaction, before any key material is generated, so
    // a workspace archived between a check and the write cannot let one
    // through and nothing is minted or revoked on the way to the refusal.
    const [workspace] = await tx
      .select({
        name: schema.workspaces.name,
        archivedAt: schema.workspaces.archivedAt,
      })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, oldKey.workspaceId),
          eq(schema.workspaces.orgId, ctx.orgId),
        ),
      )
      .limit(1);
    if (!workspace) {
      throw new HandlerError({
        code: "not_found",
        reason: "workspace_not_found",
        message: "Not found: this workspace does not exist in this org",
      });
    }
    if (workspace.archivedAt !== null) {
      throw new HandlerError({
        code: "conflict",
        reason: "workspace_archived",
        message: `${workspace.name} was archived on ${workspace.archivedAt.toISOString()}; a key cannot be rotated in an archived workspace`,
      });
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

    return {
      inserted,
      rawKey,
      revokedPublicId: oldKey.publicId,
      workspaceId: oldKey.workspaceId,
    };
  });

  // ── Emit audit events (fire-and-forget) ────────────────────────────────────
  emitSecurityEvent({
    eventType: "api_key.created",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    // The replacement key inherits the rotated key's workspace, so the audit
    // row must carry that same scope — a workspace-filtered compliance feed
    // (audit.log.query narrows security_events by workspaceId) would otherwise
    // show api_key.created without its matching api_key.revoked.
    workspaceId: result.workspaceId,
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
    workspaceId: result.workspaceId,
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
