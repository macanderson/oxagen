// api.key.create.ts — handler for the api.key.create capability.
//
// Flow:
//   1. Auth + scope guard — require authenticated principal + orgId.
//   2. Role gate — actor must hold Owner or Admin in the org.
//   3. Generate a cryptographically-random API key:
//        rawKey = "ox_" + base64url(randomBytes(32))
//        prefix = first 12 chars of rawKey
//        keyHash = SHA-256(rawKey) as hex
//   4. Insert the api_keys row (prefix + hash in plaintext; raw key never stored).
//   5. Emit api_key.created security event (fire-and-forget).
//   6. Return the rawKey — it will never be recoverable again.

import { createHash, randomBytes } from "node:crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { apiKeyCreate } from "@oxagen/oxagen/contracts/api.key.create";
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

/** Generate a secure API key in the format: ox_<base64url(32 random bytes)> */
function generateApiKey(): { rawKey: string; keyPrefix: string; keyHash: string } {
  const rawKey = "ox_" + randomBytes(32).toString("base64url");
  // Use the first 12 characters as the searchable prefix. This is enough to
  // disambiguate while still being opaque without the full key.
  const keyPrefix = rawKey.slice(0, 12);
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  return { rawKey, keyPrefix, keyHash };
}

export const apiKeyCreateHandler: CapabilityHandler<typeof apiKeyCreate> = async (input, ctx) => {
  // ── Auth + scope guard ─────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn({ orgId: ctx.orgId }, "api.key.create: rejected — no authenticated principal");
    throw new CapabilityError("api.key.create", "authz_denied", "Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId) {
    logger.warn({}, "api.key.create: rejected — missing orgId");
    throw new CapabilityError("api.key.create", "authz_denied", "Forbidden: orgId is required");
  }

  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";

  // ── Role gate ─────────────────────────────────────────────────────────────
  // Only org Owners and Admins may create API keys.
  const actorRole = await resolveActorRole(ctx.orgId, actorId);
  if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
    logger.warn(
      { orgId: ctx.orgId, actorId, actorRole },
      "api.key.create: rejected — insufficient org role",
    );
    throw new CapabilityError("api.key.create", "authz_denied", "Forbidden: only org Owners and Admins can create API keys");
  }

  // ── Generate key material ─────────────────────────────────────────────────
  const { rawKey, keyPrefix, keyHash } = generateApiKey();
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

  // ── Insert row ────────────────────────────────────────────────────────────
  // The api_keys.workspace_id column is NOT NULL (orgScopeMixin). API keys are
  // created in the context of a specific workspace (the calling route provides
  // one). The resolveApiKey resolver returns the stored workspaceId to bind the
  // machine-auth scope to that workspace on each request.
  if (!ctx.workspaceId) {
    throw new CapabilityError("api.key.create", "authz_denied", "Forbidden: workspaceId is required to create an API key");
  }

  const [inserted] = await withTenantDb((tx) =>
    tx
      .insert(schema.apiKeys)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        keyPrefix,
        keyHash,
        name: input.name,
        scope: input.scope ?? {},
        ...(expiresAt ? { expiresAt } : {}),
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
      }),
  );

  if (!inserted) {
    throw new Error("Internal error: failed to create API key row");
  }

  // ── Emit audit event (fire-and-forget) ────────────────────────────────────
  emitSecurityEvent({
    eventType: "api_key.created",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "api.key.create",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorId,
      keyPublicId: inserted.publicId,
      surface: ctx.surface,
    },
    "api.key.create: API key created",
  );

  const baseOutput = {
    keyId: inserted.id,
    publicId: inserted.publicId,
    name: inserted.name,
    keyPrefix: inserted.keyPrefix,
    rawKey,
    expiresAt: inserted.expiresAt?.toISOString() ?? null,
    createdAt: inserted.createdAt.toISOString(),
  };

  // Include render directive for the app surface to display the key component in chat
  if (ctx.surface === "app") {
    return {
      ...baseOutput,
      render: {
        componentId: "api-key-display",
        props: {
          keyId: inserted.id,
          publicId: inserted.publicId,
          name: inserted.name,
          rawKey,
          createdAt: inserted.createdAt.toISOString(),
          expiresAt: inserted.expiresAt?.toISOString() ?? null,
        },
      },
    };
  }

  return baseOutput;
};
