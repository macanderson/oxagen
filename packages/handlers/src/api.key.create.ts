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

import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { apiKeyCreate } from "@oxagen/oxagen/contracts/api.key.create";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq } from "drizzle-orm";
import {
  API_KEY_AUTHORIZED_ROLES as AUTHORIZED_ROLES,
  resolveActorOrgRole as resolveActorRole,
  generateApiKey,
} from "./lib/api-key-authz";
import { requestsReservedStellaTelemetryPurpose } from "./lib/stella-telemetry-enrollment";
import {
  requestsReservedTachoGatewayPurpose,
  requestsReservedTachoPurpose,
} from "./lib/tacho-enrollment";
import { requestsReservedLedgerRunPurpose } from "@oxagen/oxagen/ledger-run-token";
import { requestsReservedCliSessionPurpose } from "@oxagen/oxagen/cli-session";
import { requestsReservedAgentCredentialPurpose } from "@oxagen/oxagen/agent-credential";
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
  if (
    requestsReservedTachoPurpose(input.scope) ||
    requestsReservedTachoGatewayPurpose(input.scope)
  ) {
    logger.warn(
      { orgId: ctx.orgId },
      "api.key.create: rejected — reserved Tacho host purpose",
    );
    throw new CapabilityError(
      "create_api_key",
      "authz_denied",
      "Forbidden: reserved API-key scope purpose",
    );
  }

  if (requestsReservedAgentCredentialPurpose(input.scope)) {
    logger.warn(
      { orgId: ctx.orgId },
      "api.key.create: rejected — reserved agent credential purpose",
    );
    throw new CapabilityError(
      "create_api_key",
      "authz_denied",
      "Forbidden: reserved API-key scope purpose",
    );
  }

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

  if (
    requestsReservedCliSessionPurpose(input.scope) ||
    requestsReservedLedgerRunPurpose(input.scope)
  ) {
    logger.warn(
      { orgId: ctx.orgId },
      "api.key.create: reserved session or run credential purpose",
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

  // Audited when the workspace lock below was added, because a blocking lock
  // turns every check that precedes it into a check-before-wait. `rotate_api_key`
  // needed a re-check after the lock for exactly that reason. This handler does
  // not, and the enumeration is the argument:
  //
  //   - the principal, `orgId` and `workspaceId` guards read `ctx`, which is
  //     fixed for the request;
  //   - the four reserved-purpose refusals read `input.scope`, also fixed;
  //   - `expiresAt` is parsed from input and never compared to the clock here,
  //     so unlike a rotation there is no time-dependent precondition to go
  //     stale while this transaction queues;
  //   - the key material above is random bytes, and nothing is persisted or
  //     returned unless the insert commits.
  //
  // That leaves the org role, which is read before the transaction. It can be
  // revoked mid-request here as in every other handler in this package; the wait
  // widens that window rather than creating it, and narrowing it belongs to
  // whatever makes role checks transactional everywhere, not to this capability.
  const [inserted] = await withTenantDb(async (tx) => {
    // An archived workspace is wound down. Its existing keys stop
    // authenticating (ADR-105) without being revoked, and the Organization ›
    // API keys page lists them so an operator can revoke one for good. Minting
    // a new one there would be a credential issued into a closed workspace —
    // dead the moment it is handed over, and alive again the moment the
    // workspace is restored, which is fresh machine access nobody asked for.
    //
    // Refused the way `workspace.settings.write` refuses an edit to an
    // archived workspace.
    //
    // The `.for("update")` is load-bearing; do not remove it as redundant.
    // Being inside one transaction makes these two statements atomic with
    // respect to *failure* — it does nothing about a concurrent writer to a
    // row nobody locked. Postgres runs READ COMMITTED here, so an unlocked
    // SELECT takes its snapshot at statement start and `archive_workspace`
    // could commit in the window before the insert, which would then land in a
    // workspace that is archived by the time it commits.
    //
    // The row lock closes exactly that: `archive_workspace` updates this row
    // (`workspace.archive.ts`), so it either blocks until this transaction
    // commits — archiving a workspace that has just issued a key, which is the
    // honest ordering — or commits first, and this select re-reads the latest
    // committed version, sees `archived_at` and refuses.
    const [workspace] = await tx
      .select({
        name: schema.workspaces.name,
        archivedAt: schema.workspaces.archivedAt,
      })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, ctx.workspaceId),
          eq(schema.workspaces.orgId, ctx.orgId),
        ),
      )
      .limit(1)
      .for("update");
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
        message: `${workspace.name} was archived on ${workspace.archivedAt.toISOString()}; a key cannot be created in an archived workspace`,
      });
    }
    return tx
      .insert(schema.apiKeys)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        keyPrefix,
        keyHash,
        name: input.name,
        scope: input.scope ?? {},
        ...(expiresAt ? { expiresAt } : {}),
        createdById: ctx.userId ?? undefined,
        updatedById: ctx.userId ?? undefined,
      })
      .returning({
        id: schema.apiKeys.id,
        publicId: schema.apiKeys.publicId,
        name: schema.apiKeys.name,
        keyPrefix: schema.apiKeys.keyPrefix,
        expiresAt: schema.apiKeys.expiresAt,
        createdAt: schema.apiKeys.createdAt,
      });
  });

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
