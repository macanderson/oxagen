// api.key.revoke.ts — handler for the api.key.revoke capability.
//
// Flow:
//   1. Auth + scope guard — require authenticated principal + orgId.
//   2. Role gate — actor must hold Owner or Admin in the org.
//   3. Resolve the key by publicId within ctx.orgId (IDOR guard: 404 if the
//      key does not belong to this org, or if it is already revoked).
//   4. Reserved-purpose guard — refuse a server-owned credential, naming the
//      capability that owns its lifecycle.
//   5. Soft-delete: set deletedAt = now(), deletedByUserId = actorId.
//   6. Emit api_key.revoked security event (fire-and-forget).
//
// WHY STEP 4 EXISTS. `auth.api_keys` holds two kinds of row: keys an operator
// minted here, and credentials the platform minted for something it also
// tracks elsewhere. `api.key.create` refuses to MINT any of the four
// server-owned purposes and `api.key.rotate` refuses to ROTATE them, each
// naming the path that owns it. Revoke had neither check, and its single
// `UPDATE auth.api_keys SET deleted_at` is not what revoking those credentials
// means:
//
//   tacho_host_v1    → revoke_tacho_enrollment, via revokeHostEnrollment,
//     which does THREE writes: the host row becomes `revoked` with its reason,
//     the key is soft-deleted, and a `revoke` control command is queued so a
//     collector mid-poll stops at once rather than at its next bundle refresh.
//     A generic revoke does only the middle one. The credential dies,
//     `tacho_hosts.status` still reads `active`, no command is queued, and the
//     fleet record now says a host is live that cannot authenticate. A revoke
//     that appears to succeed and leaves the record lying is worse than one
//     that refuses.
//   agent_credential_v1 → rotate_agent_credential / retire_agent, where the
//     revoke is always PAIRED — with a fresh mint, or with the agent's
//     retirement in one transaction. Unpaired, the agent row stays live with
//     no credential and nothing re-mints.
//   stella_operational_telemetry_v1 → operator enrollment. No governed revoke
//     exists yet, so a generic one ends ingestion with nothing recording why.
//   cli_session_v1 → replaced by `oxagen login`. No second row to corrupt, but
//     rotate already refuses it, and two sibling capabilities answering the
//     same question differently is how several defects on this PR started.
//
// Reachable from every surface, not just the app: the org tokens panel read
// `auth.api_keys` (policy class `standard`) under the org-only workspace
// sentinel, so RLS answered it none of these rows and the omission could not
// be seen there. Widening that read is what surfaced it; api, mcp and cli
// could always reach it. Fixed in the capability rather than by filtering the
// panel, because a surface that hides a broken capability leaves it broken for
// the other three.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { apiKeyRevoke } from "@oxagen/oxagen/contracts/api.key.revoke";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, isNull } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  resolveActorOrgRole as resolveActorRole,
} from "./lib/api-key-authz";
import { requestsReservedStellaTelemetryPurpose } from "./lib/stella-telemetry-enrollment";
import { requestsReservedTachoPurpose } from "./lib/tacho-enrollment";
import { requestsReservedCliSessionPurpose } from "@oxagen/auth/cli-auth";
import { requestsReservedAgentCredentialPurpose } from "@oxagen/oxagen/agent-credential";
import { logger } from "./logger";

export const apiKeyRevokeHandler: CapabilityHandler<
  typeof apiKeyRevoke
> = async (input, ctx) => {
  // ── Auth + scope guard ─────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      { orgId: ctx.orgId },
      "api.key.revoke: rejected — no authenticated principal",
    );
    throw new CapabilityError(
      "revoke_api_key",
      "authz_denied",
      "Unauthorized: no authenticated principal",
    );
  }
  if (!ctx.orgId) {
    logger.warn({}, "api.key.revoke: rejected — missing orgId");
    throw new CapabilityError(
      "revoke_api_key",
      "authz_denied",
      "Forbidden: orgId is required",
    );
  }

  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";

  // ── Role gate ─────────────────────────────────────────────────────────────
  const actorRole = await resolveActorRole(ctx.orgId, actorId);
  if (!actorRole || !AUTHORIZED_ROLES.has(actorRole)) {
    logger.warn(
      { orgId: ctx.orgId, actorId, actorRole },
      "api.key.revoke: rejected — insufficient org role",
    );
    throw new CapabilityError(
      "revoke_api_key",
      "authz_denied",
      "Forbidden: only org Owners and Admins can revoke API keys",
    );
  }

  const revokedAt = new Date();

  // ── Soft-delete (IDOR-safe: must match orgId) ─────────────────────────────
  const revokedWorkspaceId = await withTenantDb(async (tx) => {
    // Verify the key belongs to this org and is not already revoked.
    const [existing] = await tx
      .select({
        id: schema.apiKeys.id,
        publicId: schema.apiKeys.publicId,
        workspaceId: schema.apiKeys.workspaceId,
        // The STORED scope, not an input field — the caller names only a
        // publicId, so what this key is for can be read from the row alone.
        scope: schema.apiKeys.scope,
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

    if (!existing) {
      logger.warn(
        { orgId: ctx.orgId, keyPublicId: input.keyPublicId },
        "api.key.revoke: key not found or already revoked",
      );
      throw new Error(
        "Not found: API key does not exist, is not in this org, or is already revoked",
      );
    }

    // ── Reserved-purpose guard ───────────────────────────────────────────────
    // Ordered and worded to match api.key.rotate exactly. Each message names
    // the capability that owns the credential's lifecycle, because "Forbidden"
    // with no destination is how an operator ends up reaching for raw SQL.
    if (requestsReservedTachoPurpose(existing.scope)) {
      logger.warn(
        { orgId: ctx.orgId, keyPublicId: existing.publicId },
        "api.key.revoke: rejected — reserved Tacho host purpose",
      );
      throw new CapabilityError(
        "revoke_api_key",
        "authz_denied",
        "Forbidden: an enrolled Tacho host key is revoked through revoke_tacho_enrollment, which also marks the host revoked and queues the revoke command",
      );
    }

    if (requestsReservedAgentCredentialPurpose(existing.scope)) {
      logger.warn(
        { orgId: ctx.orgId, keyPublicId: existing.publicId },
        "api.key.revoke: rejected — reserved agent credential purpose",
      );
      throw new CapabilityError(
        "revoke_api_key",
        "authz_denied",
        "Forbidden: an agent credential is replaced by rotate_agent_credential or ended by retire_agent",
      );
    }

    if (requestsReservedStellaTelemetryPurpose(existing.scope)) {
      logger.warn(
        { orgId: ctx.orgId, keyPublicId: existing.publicId },
        "api.key.revoke: rejected — reserved Stella telemetry purpose",
      );
      throw new CapabilityError(
        "revoke_api_key",
        "authz_denied",
        "Forbidden: an enrolled Stella telemetry key requires operator revocation",
      );
    }

    if (requestsReservedCliSessionPurpose(existing.scope)) {
      logger.warn(
        { orgId: ctx.orgId, keyPublicId: existing.publicId },
        "api.key.revoke: rejected — reserved CLI session purpose",
      );
      throw new CapabilityError(
        "revoke_api_key",
        "authz_denied",
        "Forbidden: a CLI session key is replaced by `oxagen login`, and removing the member revokes it",
      );
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

    return existing.workspaceId;
  });

  // ── Emit audit event (fire-and-forget) ────────────────────────────────────
  emitSecurityEvent({
    eventType: "api_key.revoked",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    // Carry the revoked key's own workspace, not null — audit.log.query
    // narrows security_events by workspaceId, so a null here would hide the
    // revocation from the workspace's compliance feed.
    workspaceId: revokedWorkspaceId,
    capability: "revoke_api_key",
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
