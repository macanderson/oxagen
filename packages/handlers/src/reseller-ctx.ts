import type { ResellerCtx } from "@oxagen/billing";

/** The kernel context fields every reseller handler guards on. */
interface ResellerHandlerCtx {
  userId?: string | null;
  apiKeyId?: string | null;
  orgId?: string | null;
}

/**
 * Shared authorization guard for reseller-revenue handlers: a resolved principal
 * and an org scope are required. Mirrors the billing.subscription/upgrade guards
 * so the check is surface-agnostic (API, MCP, agent) — apps/app additionally
 * asserts billing-manager at the call site (the kernel skips IAM there).
 */
export function requireResellerCtx(ctx: ResellerHandlerCtx): ResellerCtx {
  if (!ctx.userId && !ctx.apiKeyId) {
    throw new Error("Unauthorized: no authenticated principal");
  }
  if (!ctx.orgId) {
    throw new Error(
      "Forbidden: orgId is required for reseller-revenue operations",
    );
  }
  return { orgId: ctx.orgId, userId: ctx.userId ?? null };
}
