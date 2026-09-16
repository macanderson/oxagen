"use server";

import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { apiKeyCreate } from "@oxagen/oxagen/contracts/api.key.create";
import { apiKeyRevoke } from "@oxagen/oxagen/contracts/api.key.revoke";
import { apiKeyRotate } from "@oxagen/oxagen/contracts/api.key.rotate";
import type { ApiKeyCreateOutput } from "@oxagen/oxagen/contracts/api.key.create";
import type { ApiKeyRevokeOutput } from "@oxagen/oxagen/contracts/api.key.revoke";
import type { ApiKeyRotateOutput } from "@oxagen/oxagen/contracts/api.key.rotate";
import { schema, withSystemDb } from "@oxagen/database";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgAdmin } from "@/lib/resolve-org";
import { revalidatePath } from "next/cache";

// A key's workspace is part of the credential, not a label on it: every bearer
// surface builds its tenant scope from the (org_id, workspace_id) pair stored
// on the row (packages/auth/src/resolvers/api-key.ts), and `auth.api_keys` is
// policy class `standard`, so the RLS predicate compares workspace_id to the
// workspace GUC.
//
// These actions used to invoke with the org-only workspace sentinel. The
// handlers resolve the key under withTenantDb, so a key minted into a real
// workspace — every key `oxagen login` mints, see
// apps/api/src/routes/v1/auth.cli.token.ts — resolved to undefined and the
// operator was told the key does not exist while it kept authenticating.
//
// The fix belongs here rather than in the handler: an org-level surface reaches
// a workspace-scoped table by re-entering that workspace's scope. The key names
// the workspace, so the action resolves it first and invokes inside it.

/**
 * The workspace a key belongs to, within this org.
 *
 * withSystemDb with an explicit and(orgId, publicId) fence: there is no scope
 * to read this under yet, because finding the scope is what this does. The org
 * fence is the isolation, and a key outside the caller's org resolves to null,
 * which the caller turns into the same `not_found` the handler would raise.
 */
async function resolveKeyWorkspaceId(
  orgId: string,
  keyPublicId: string,
): Promise<string | null> {
  const [row] = await withSystemDb((tx) =>
    tx
      .select({ workspaceId: schema.apiKeys.workspaceId })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.orgId, orgId),
          eq(schema.apiKeys.publicId, keyPublicId),
          isNull(schema.apiKeys.deletedAt),
        ),
      )
      .limit(1),
  );
  return row?.workspaceId ?? null;
}

/**
 * The workspace a newly minted key belongs to.
 *
 * ADR-069 settled that an API key names a workspace: create_api_key persists
 * ctx.workspaceId, and the sentinel satisfied the `standard` policy's WITH
 * CHECK (the row carried the sentinel too), so the insert succeeded and the
 * secret shown once named a workspace no row answers to. Such a key
 * authenticates into nothing — resolveApiKey hands its callers a scope in
 * which every `standard` table is empty.
 *
 * ADR-069's answer is that the page names the workspace; the rebuilt Mission
 * Control page does that with a `?workspace=` picker. This page is the
 * retiring app and has no picker, so it mints into the oldest workspace of
 * this org that the acting user is a member of — the same membership boundary
 * resolveApiKey enforces for a CLI key. An org with no such workspace gets a
 * refusal rather than an inert credential.
 */
async function resolveMintWorkspaceId(
  orgId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await withSystemDb((tx) =>
    tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .innerJoin(
        schema.workspaceUsers,
        eq(schema.workspaceUsers.workspaceId, schema.workspaces.id),
      )
      .where(
        and(
          eq(schema.workspaces.orgId, orgId),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .orderBy(asc(schema.workspaces.createdAt))
      .limit(1),
  );
  return row?.id ?? null;
}

async function buildApiKeyCtx(orgSlug: string) {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  // invoke() from apps/app skips kernel IAM, and orgSlug is client-supplied.
  // api.key.* is sensitivity:"high", Owner/Admin-only (defaultRoles.org) — a
  // minted key grants programmatic org access — so replicate that role gate
  // here. Without it any authenticated user could mint/revoke/rotate keys for
  // any org by passing its slug. notFound() on non-admin/non-member.
  await assertOrgAdmin(org.id, session.user.id);
  // No workspaceId: there is no honest org-level value for it on a `standard`
  // table, and the sentinel that used to sit here is what broke all three
  // actions. Each action resolves the real workspace and adds it below.
  return {
    orgId: org.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

export async function createApiKeyAction(input: {
  orgSlug: string;
  name: string;
  expiresAt?: string;
}): Promise<ApiKeyCreateOutput> {
  const ctx = await buildApiKeyCtx(input.orgSlug);
  const parsedInput = apiKeyCreate.input.parse({
    name: input.name,
    expiresAt: input.expiresAt,
  });
  const workspaceId = await resolveMintWorkspaceId(ctx.orgId, ctx.userId);
  if (workspaceId === null) {
    throw new Error(
      "No workspace to mint this key into. A key authenticates into a workspace, so create a workspace you are a member of first.",
    );
  }
  const result = await invoke(
    apiKeyCreate.name,
    parsedInput,
    { ...ctx, workspaceId },
    { surface: "agent" },
  );
  revalidatePath(`/${input.orgSlug}/developer/tokens`);
  return apiKeyCreate.output.parse(result);
}

export async function revokeApiKeyAction(input: {
  orgSlug: string;
  keyPublicId: string;
}): Promise<ApiKeyRevokeOutput> {
  const ctx = await buildApiKeyCtx(input.orgSlug);
  const parsedInput = apiKeyRevoke.input.parse({
    keyPublicId: input.keyPublicId,
  });
  const workspaceId = await resolveKeyWorkspaceId(
    ctx.orgId,
    parsedInput.keyPublicId,
  );
  if (workspaceId === null) {
    throw new Error(
      "Not found: API key does not exist, is not in this org, or is already revoked",
    );
  }
  const result = await invoke(
    apiKeyRevoke.name,
    parsedInput,
    { ...ctx, workspaceId },
    { surface: "agent" },
  );
  revalidatePath(`/${input.orgSlug}/developer/tokens`);
  return apiKeyRevoke.output.parse(result);
}

export async function rotateApiKeyAction(input: {
  orgSlug: string;
  keyPublicId: string;
  name?: string;
}): Promise<ApiKeyRotateOutput> {
  const ctx = await buildApiKeyCtx(input.orgSlug);
  const parsedInput = apiKeyRotate.input.parse({
    keyPublicId: input.keyPublicId,
    name: input.name,
  });
  const workspaceId = await resolveKeyWorkspaceId(
    ctx.orgId,
    parsedInput.keyPublicId,
  );
  if (workspaceId === null) {
    throw new Error(
      "Not found: API key does not exist, is not in this org, or is already revoked",
    );
  }
  // The replacement is minted into the rotated key's workspace, so rotation
  // preserves the credential's scope rather than moving it.
  const result = await invoke(
    apiKeyRotate.name,
    parsedInput,
    { ...ctx, workspaceId },
    { surface: "agent" },
  );
  revalidatePath(`/${input.orgSlug}/developer/tokens`);
  return apiKeyRotate.output.parse(result);
}
