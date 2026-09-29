// entitlement.ts: whether an organization may use a relay credential.
//
// A credential the relay adds from its own environment is an Enterprise
// feature (mcp-studio-spec, Network paths). The check follows
// packages/handlers/src/lib/sso.ts: use the plan tier the caller already
// resolved, and look it up only when the caller has none.
//
// @oxagen/billing reaches the database and Stripe, so it loads on the first
// check rather than when the broker loads.
import type { PlanTier } from "@oxagen/oxagen/types";

export type CredentialEntitlement = (orgId: string, planTier: PlanTier | undefined) => Promise<boolean>;

/** True when the organization's plan is Enterprise. */
export const relayCredentialEntitled: CredentialEntitlement = async (orgId, planTier) => {
  const { meetsMinimumTier, resolveOrgTier } = await import("@oxagen/billing");
  return meetsMinimumTier(planTier ?? (await resolveOrgTier(orgId)), "enterprise");
};
