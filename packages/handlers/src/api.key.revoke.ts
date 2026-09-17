// api.key.revoke.ts — handler for the api.key.revoke capability.
//
// Flow:
//   1. Auth + scope guard — require authenticated principal + orgId.
//   2. Role gate — actor must hold Owner or Admin in the org.
//   3. Resolve the key by publicId within ctx.orgId (IDOR guard: a key that
//      does not belong to this org, or is already revoked, is refused as
//      HandlerError { code: "not_found", reason: "api_key_not_found" }, which
//      every surface classifies — the API as 404, the app as `not_found`. An
//      untyped Error here reached the app as an unavailable control plane, so
//      revoking a key twice read as an outage.
//   4. Reserved-purpose guard — refuse a server-owned credential, naming the
//      capability that owns its lifecycle.
//   5. Soft-delete: set deletedAt = now(), deletedById = actorId.
//   6. Emit api_key.revoked security event (fire-and-forget).
//
// WHY STEP 4 EXISTS. `auth.api_keys` holds two kinds of row: keys an operator
// minted here, and credentials the platform minted for something it also
// tracks elsewhere. For those, this handler's single
// `UPDATE auth.api_keys SET deleted_at` is not what revoking them means.
//
// THE TEST A REFUSAL HAS TO PASS: **the path the refusal names must achieve
// what the refused operation was for.** Refusing without that is not a guard,
// it is the removal of a capability — and for a revoke, the capability removed
// is the ability to invalidate a leaked credential.
//
// APPLIED PER PURPOSE, one line each, because stating the rule once and then
// reasoning about "the set of server-owned purposes" is exactly how two wrong
// refusals got in. Being server-owned is not the test. All four are.
//
//   REFUSED — tacho_host_v1 → `revoke_tacho_enrollment` revokes, and more
//     completely: `revokeHostEnrollment` marks the host row `revoked` with its
//     reason, soft-deletes the key, and queues a `revoke` control command so a
//     collector mid-poll stops at once. A generic revoke does only the middle
//     write, leaving `tacho_hosts.status` reading `active` — the fleet record
//     claiming a host is live that cannot authenticate. PASSES.
//   REFUSED — tacho_gateway_v1 → the same path, for the enrolment's second
//     credential (ADR-078): the key the machine's local MCP gateway presents
//     to serve tools to a connected app. `revoke_tacho_enrollment` ends the
//     enrolment's credentials together and marks the host revoked. A generic
//     revoke of the gateway key alone leaves the host row `active` and its
//     host key reporting events while every connected app's tool call fails
//     auth, with nothing on the record saying the credential was ended.
//     PASSES.
//   REFUSED — agent_credential_v1 → `rotate_agent_credential` and
//     `retire_agent` both revoke, and pair it with a fresh mint or with the
//     agent's retirement in one transaction. Unpaired, the agent row stays live
//     with no credential and nothing re-mints. PASSES.
//   NOT REFUSED — stella_operational_telemetry_v1 → there is no Stella
//     revocation path. `create_stella_enrollment` and
//     `ingest_stella_operational_telemetry` are the only two Stella
//     capabilities, and enrollment writes nothing but `auth.api_keys` — no
//     lifecycle row to leave inconsistent. Soft-deleting the key and emitting
//     `api_key.revoked` IS the whole job here. FAILS: the refusal named
//     "operator revocation", which does not exist.
//   NOT REFUSED — cli_session_v1 → `oxagen login`
//     (apps/api/src/routes/v1/auth.cli.token.ts) only INSERTS another key and
//     never soft-deletes the previous one, so the old credential stays live;
//     `oxagen logout` clears ~/.config/oxagen/config.json and makes no server
//     call; there is no session-scoped revoke route. Refusing leaves
//     `remove_org_member` as the only revocation — which also strips the
//     person's org access, so a compromised laptop costs them their
//     membership. FAILS.
//
// BOTH failures were the same mistake, and both had the answer already written
// on this page before the refusal was added: the earlier revision's own notes
// read "no second row to corrupt" for cli_session_v1 and "no governed revoke
// exists" for Stella. Each is the statement that the rationale DOES NOT APPLY
// to that purpose, and each was read as permission to refuse anyway because the
// set looked untidy with a gap in it. A rule stated once and applied to a set is
// how that happens twice in one commit; hence the per-purpose lines above.
//
// Rotate is genuinely different and its refusals stay correct, because rotation
// is for obtaining a fresh working credential and every path it names does
// that: `oxagen login` for a CLI session, `create_stella_enrollment` and
// operator re-enrollment for the other two. None of them invalidates the old
// credential, which is why the same paths fail this capability's test.
// Rotating a CLI session would also return the new raw key through the
// capability's output with nothing writing it into the operator's config file.
//
// If a Stella or session-scoped revoke capability is built later, move that
// purpose into the refused set and give it a line above. Until then both must
// stay revocable, and `api.key.revoke.test.ts` asserts each one so restoring
// the symmetry fails loudly rather than silently closing the only door.
//
// Reachable from every surface, not just the app: the org tokens panel read
// `auth.api_keys` (policy class `standard`) under the org-only workspace
// sentinel, so RLS answered it none of these rows and the omission could not
// be seen there. Widening that read is what surfaced it; api, mcp and cli
// could always reach it. Fixed in the capability rather than by filtering the
// panel, because a surface that hides a broken capability leaves it broken for
// the other three.

import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { apiKeyRevoke } from "@oxagen/oxagen/contracts/api.key.revoke";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, isNull } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  resolveActorOrgRole as resolveActorRole,
} from "./lib/api-key-authz";
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
      throw new HandlerError({
        code: "not_found",
        reason: "api_key_not_found",
        message:
          "Not found: API key does not exist, is not in this org, or is already revoked",
      });
    }

    // ── Reserved-purpose guard ───────────────────────────────────────────────
    // Ordered and worded to match api.key.rotate exactly. Each message names
    // the capability that owns the credential's lifecycle, because "Forbidden"
    // with no destination is how an operator ends up reaching for raw SQL.
    if (requestsReservedTachoPurpose(existing.scope)) {
      logger.warn(
        { orgId: ctx.orgId, keyPublicId: existing.publicId },
        "api.key.revoke: rejected — reserved Tacho enrollment purpose",
      );
      throw new CapabilityError(
        "revoke_api_key",
        "authz_denied",
        "Forbidden: an enrolled Tacho host's credentials — its host key and its gateway key — are revoked through revoke_tacho_enrollment, which also marks the host revoked and queues the revoke command",
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

    // DELIBERATELY NOT REFUSED, both with a per-purpose line in the header:
    //
    //   stella_operational_telemetry_v1 — no Stella revocation capability
    //     exists, and enrollment writes nothing but auth.api_keys, so the
    //     soft-delete below IS the whole job.
    //   cli_session_v1 — `oxagen login` only mints another key and
    //     `oxagen logout` is local-only, so this is the only proportionate way
    //     to invalidate a lost CLI credential; refusing would leave
    //     `remove_org_member` as the sole revocation, at the cost of the
    //     person's org access.
    //
    // Both were refused in an earlier revision on a symmetry argument. Add a
    // purpose here only when a path exists that actually revokes it.

    await tx
      .update(schema.apiKeys)
      .set({
        deletedAt: revokedAt,
        deletedById: ctx.userId ?? undefined,
        updatedAt: revokedAt,
        updatedById: ctx.userId ?? undefined,
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
