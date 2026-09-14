"use server";

import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { apiKeyCreate } from "@oxagen/oxagen/contracts/api.key.create";
import { apiKeyRevoke } from "@oxagen/oxagen/contracts/api.key.revoke";
import { apiKeyRotate } from "@oxagen/oxagen/contracts/api.key.rotate";
import type { ApiKeyCreateOutput } from "@oxagen/oxagen/contracts/api.key.create";
import type { ApiKeyRevokeOutput } from "@oxagen/oxagen/contracts/api.key.revoke";
import type { ApiKeyRotateOutput } from "@oxagen/oxagen/contracts/api.key.rotate";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgAdmin } from "@/lib/resolve-org";
import { revalidatePath } from "next/cache";

// API keys are org-scoped. Sentinel workspace ID for org-only routes.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

async function buildApiKeyCtx(orgSlug: string) {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  // invoke() from apps/app skips kernel IAM, and orgSlug is client-supplied.
  // api.key.* is sensitivity:"high", Owner/Admin-only (defaultRoles.org) — a
  // minted key grants programmatic org access — so replicate that role gate
  // here. Without it any authenticated user could mint/revoke/rotate keys for
  // any org by passing its slug. notFound() on non-admin/non-member.
  await assertOrgAdmin(org.id, session.user.id);
  return {
    orgId: org.id,
    workspaceId: ORG_ONLY_WS,
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
  const result = await invoke(apiKeyCreate.name, parsedInput, ctx, {
    surface: "agent",
  });
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
  const result = await invoke(apiKeyRevoke.name, parsedInput, ctx, {
    surface: "agent",
  });
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
  const result = await invoke(apiKeyRotate.name, parsedInput, ctx, {
    surface: "agent",
  });
  revalidatePath(`/${input.orgSlug}/developer/tokens`);
  return apiKeyRotate.output.parse(result);
}
