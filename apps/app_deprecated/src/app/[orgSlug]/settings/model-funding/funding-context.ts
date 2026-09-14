/**
 * funding-context.ts — the org-only capability context the model-funding
 * page and its server actions share.
 *
 * Not a `"use server"` module on purpose: such a module may export only
 * async functions, and both `page.tsx` and `funding-actions.ts` need the
 * same sentinel and the same context builder.
 */
import type { CapabilityContext } from "@oxagen/oxagen/types";

/**
 * Sentinel workspaceId for org-only work. The model credential and the
 * assistant cap are organisation rows with no workspace behind them; the
 * nil UUID satisfies `runInTenantScope`'s uuid guard while the org-only RLS
 * policy class ignores the workspace GUC. Same value as
 * `../general/general-action.ts`.
 */
export const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

/** Org roles allowed to see or change who pays for the assistant. */
export const FUNDING_MANAGER_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
]);

/**
 * Build the context an org-level capability call carries when a signed-in
 * person makes it from the app.
 */
export function buildOrgCapabilityContext(opts: {
  orgId: string;
  userId: string;
}): CapabilityContext {
  return {
    orgId: opts.orgId,
    workspaceId: ORG_ONLY_WS,
    userId: opts.userId,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };
}
