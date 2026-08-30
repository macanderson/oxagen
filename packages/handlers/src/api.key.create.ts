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

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { apiKeyCreate } from "@oxagen/oxagen/contracts/api.key.create";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  resolveActorOrgRole as resolveActorRole,
  generateApiKey,
} from "./lib/api-key-authz";
import { requestsReservedStellaTelemetryPurpose } from "./lib/stella-telemetry-enrollment";
import { logger } from "./logger";

export const apiKeyCreateHandler: CapabilityHandler<
  typeof apiKeyCreate
> = async (input, ctx) => {
  // ── Auth + scope guard ─────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      { orgId: ctx.orgId },
      "api.key.create: rejected — no authenticated principal",
    );
    throw new CapabilityError(
      "create_api_key",
      "authz_denied",
      "Unauthorized: no authenticated principal",
    );
  }
  if (!ctx.orgId) {
    logger.warn({}, "api.key.create: rejected — missing orgId");
    throw new CapabilityError(
      "create_api_key",
      "authz_denied",
      "Forbidden: orgId is required",
    );
  }

  // The generic key-management capability must never mint the server-owned
  // enrollment marker. Provisioning is a separate operator workflow; allowing
  // callers to self-assert this purpose would bypass the intake trust boundary.
  if (requestsReservedStellaTelemetryPurpose(input.scope)) {
    logger.warn(
      { orgId: ctx.orgId },
      "api.key.create: rejected — reserved Stella telemetry purpose",
    );
    throw new CapabilityError(
      "create_api_key",
      "authz_denied",
      "Forbidden: reserved API-key scope purpose",
    );
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
    throw new CapabilityError(
      "create_api_key",
      "authz_denied",
      "Forbidden: only org Owners and Admins can create API keys",
    );
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
    throw new CapabilityError(
      "create_api_key",
      "authz_denied",
      "Forbidden: workspaceId is required to create an API key",
    );
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
    // The workspace guard above already proved ctx.workspaceId is present, and
    // the key is bound to it — the audit row must carry the same scope.
    workspaceId: ctx.workspaceId,
    capability: "create_api_key",
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
