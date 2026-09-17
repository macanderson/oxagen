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
// tracks elsewhere. For those, this handler's single
// `UPDATE auth.api_keys SET deleted_at` is not what revoking them means.
//
// THE TEST A REFUSAL HAS TO PASS: **the path the refusal names must achieve
// what the refused operation was for.** Refusing without that is not a guard,
// it is the removal of a capability. Three purposes pass it, one does not, and
// the difference is not which of them is "server-owned" — all four are.
//
//   tacho_host_v1    → revoke_tacho_enrollment, via revokeHostEnrollment,
//     which does THREE writes: the host row becomes `revoked` with its reason,
//     the key is soft-deleted, and a `revoke` control command is queued so a
//     collector mid-poll stops at once rather than at its next bundle refresh.
//     A generic revoke does only the middle one. The credential dies,
//     `tacho_hosts.status` still reads `active`, no command is queued, and the
//     fleet record now says a host is live that cannot authenticate. A revoke
//     that appears to succeed and leaves the record lying is worse than one
//     that refuses — and the named path does revoke, more completely.
//   agent_credential_v1 → rotate_agent_credential / retire_agent, where the
//     revoke is always PAIRED — with a fresh mint, or with the agent's
//     retirement in one transaction. Unpaired, the agent row stays live with
//     no credential and nothing re-mints. Both named paths revoke.
//   stella_operational_telemetry_v1 → operator enrollment, which revokes.
//
// NOT REFUSED — cli_session_v1, and this is the exclusion to confront rather
// than tidy away. An earlier revision of this guard refused it too, for
// symmetry with rotate and because there is no second row to corrupt. Both
// observations are true and neither is a reason: "no second row to corrupt" is
// the statement that the rationale above DOES NOT APPLY here, and it was read
// as permission to refuse anyway.
//
// It fails the test outright. `oxagen login` (apps/api/src/routes/v1/
// auth.cli.token.ts) only INSERTS another key — it never soft-deletes the
// previous one, so the old credential stays live. `oxagen logout` clears
// ~/.config/oxagen/config.json and makes no server call at all. There is no
// session-scoped revoke route. So refusing here leaves exactly one way to
// invalidate a lost or compromised CLI key: `remove_org_member`, which revokes
// every CLI key that person holds AND removes their org access. That trades a
// proportionate security control for an argument about consistency, and a
// compromised laptop then costs the operator their entire membership.
//
// Rotate is genuinely different, which is why its refusal stays correct: a
// rotation hands the new raw key back through the capability's output, and
// nothing writes it into the operator's config file, so a rotated CLI session
// would revoke the working credential and mint one the CLI never receives.
// `oxagen login` DOES achieve what rotation is for — a fresh working
// credential. It does not achieve what revocation is for.
//
// If a session-scoped revoke capability is built later, move cli_session_v1
// into the refused set and name it here. Until then it must stay revocable,
// and `api.key.revoke.test.ts` asserts that so restoring the symmetry fails
// loudly rather than silently closing the only door.
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

    // DELIBERATELY NOT REFUSED: cli_session_v1. See the header — `oxagen login`
    // only mints another key and `oxagen logout` is local-only, so this is the
    // only proportionate way to invalidate a lost CLI credential. Adding it to
    // the set above would leave `remove_org_member` as the sole revocation, at
    // the cost of the person's org access.

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
