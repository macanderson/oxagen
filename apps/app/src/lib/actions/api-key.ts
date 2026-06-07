"use server";

import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { apiKeyCreate } from "@oxagen/oxagen/contracts/api.key.create";
import type { ApiKeyCreateOutput } from "@oxagen/oxagen/contracts/api.key.create";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";

export async function createApiKeyAction(input: {
  orgSlug: string;
  name: string;
  expiresAt?: string;
}): Promise<ApiKeyCreateOutput> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(input.orgSlug);

  // API keys are org-scoped. Use sentinel workspace ID for org-only routes.
  // See OXA-1515 for context on org-only workspace scoping.
  const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

  const ctx = {
    orgId: org.id,
    workspaceId: ORG_ONLY_WS,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  const parsedInput = apiKeyCreate.input.parse({
    name: input.name,
    expiresAt: input.expiresAt,
  });

  const result = await invoke(apiKeyCreate.name, parsedInput, ctx, { surface: "agent" });
  return apiKeyCreate.output.parse(result);
}
