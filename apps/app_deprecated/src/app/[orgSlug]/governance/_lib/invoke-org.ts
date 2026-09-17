import { invoke } from "@oxagen/oxagen";
// Side-effect import binds every handler into the kernel — without it invoke()
// throws "No handler registered". Mirrors the other app-side invoke call sites.
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";

/** Sentinel workspaceId for org-only routes (no workspace context). */
export const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

/**
 * Invoke a capability from an org-scope governance surface.
 *
 * apps/app does not bootstrap kernel IAM, so callers MUST gate before calling
 * (assertOrgMember / assertOrgAdmin at the page or action seam). No
 * opts.surface is claimed — app-side invokes omit the surface claim so the
 * kernel does not surface-deny (the equip-sources pattern).
 */
export async function invokeOrgCapability<T>(
  orgId: string,
  userId: string,
  name: string,
  input: unknown,
): Promise<T> {
  const ctx = {
    orgId,
    workspaceId: ORG_ONLY_WS,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
  return runInTenantScope({ orgId, workspaceId: ORG_ONLY_WS }, () =>
    invoke(name, input, ctx),
  ) as Promise<T>;
}
