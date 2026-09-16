// api.key.list.ts — handler for the list_api_keys capability.
//
// audit-exempt: read-only. Returns key metadata (public id, name, prefix and
// timestamps), never the raw key or its hash, so nothing privileged is
// disclosed; the lifecycle writes (create / revoke / rotate) each emit their
// own api_key.* event. Covered by the kernel capability.invoke_* audit.
//
// Flow:
//   1. Auth + scope guard — require an authenticated principal, an orgId and a
//      workspaceId (the tenant scope the kernel entered).
//   2. Role gate — the actor must hold Owner or Admin in the org.
//   3. Select the metadata columns for every key in scope, revoked ones
//      included, newest first.
//
// The select names its columns: key_hash is never read, so a later change to
// the row shape cannot leak it through a `select()` with no projection.
//
// `scope` is read but never returned. It is there to answer one question the
// page cannot answer for itself: whether rotate_api_key would replace this key.
// The whole answer lives in lib/api-key-rotatable.ts and the rotate handler
// refuses from the same function, so `rotatable` and the refusal cannot
// disagree — a server-owned purpose and an expiry that has passed both make a
// key unrotatable. `rotatable` is what this read saw at the instant it ran; the
// handler is the authority and checks again against its own clock. A revoked
// key is not rotatable either — this read returns revoked rows so the roster
// can show them, and rotate_api_key answers not-found for one — so revocation
// is the third reason the shared predicate weighs. Revoking is unaffected by
// all of it: a key is revocable whatever its purpose and whatever its expiry.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import { actorCanManageApiKeys } from "./lib/api-key-authz";
import { isRotatableKey } from "./lib/api-key-rotatable";
import { logger } from "./logger";

export const apiKeyListHandler: CapabilityHandler<typeof apiKeyList> = async (
  _input,
  ctx,
) => {
  // ── Auth + scope guard ─────────────────────────────────────────────────────
  if (!ctx.userId && !ctx.apiKeyId) {
    logger.warn(
      { orgId: ctx.orgId },
      "api.key.list: rejected — no authenticated principal",
    );
    throw new CapabilityError(
      "list_api_keys",
      "authz_denied",
      "Unauthorized: no authenticated principal",
    );
  }
  if (!ctx.orgId) {
    logger.warn({}, "api.key.list: rejected — missing orgId");
    throw new CapabilityError(
      "list_api_keys",
      "authz_denied",
      "Forbidden: orgId is required",
    );
  }
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "api.key.list: rejected — missing workspaceId",
    );
    throw new CapabilityError(
      "list_api_keys",
      "authz_denied",
      "Forbidden: workspaceId is required to list API keys",
    );
  }

  const { orgId, workspaceId } = ctx;
  const actorId = ctx.userId ?? ctx.apiKeyId ?? "system";

  // ── Role gate ─────────────────────────────────────────────────────────────
  if (!(await actorCanManageApiKeys(orgId, actorId))) {
    logger.warn(
      { orgId: ctx.orgId, actorId },
      "api.key.list: rejected — insufficient org role",
    );
    throw new CapabilityError(
      "list_api_keys",
      "authz_denied",
      "Forbidden: only org Owners and Admins can list API keys",
    );
  }

  // ── Read (the explicit org + workspace filter matches the RLS policy on
  // auth.api_keys, so the result is the same whether or not RLS is enforced) ─
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.apiKeys.publicId,
        name: schema.apiKeys.name,
        prefix: schema.apiKeys.keyPrefix,
        createdAt: schema.apiKeys.createdAt,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        expiresAt: schema.apiKeys.expiresAt,
        revokedAt: schema.apiKeys.deletedAt,
        scope: schema.apiKeys.scope,
      })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.orgId, orgId),
          eq(schema.apiKeys.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(schema.apiKeys.createdAt), desc(schema.apiKeys.id)),
  );

  // One instant for the whole page, so two rows of the same list cannot be
  // judged against different clocks.
  const now = Date.now();
  return {
    items: rows.map((row) => ({
      publicId: row.publicId,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      rotatable: isRotatableKey(
        {
          scope: row.scope,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
        },
        now,
      ),
    })),
  };
};
