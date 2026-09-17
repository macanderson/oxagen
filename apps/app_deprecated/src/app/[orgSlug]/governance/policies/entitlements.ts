import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";
import type { PlanTier } from "@oxagen/oxagen/types";

/**
 * Pure entitlement-gate derivation for the Policies page.
 *
 * A capability is entitlement-gated when a capability-pack plugin claims it.
 * The gate has two dimensions: the pack must be installed in the invoking
 * workspace (workspace-scoped, not knowable org-wide) and — when the pack
 * declares `minPlanTier` — the org plan must meet it (org-wide, computed
 * here against the org's current tier).
 */

const TIER_ORDER: Record<PlanTier, number> = {
  free: 0,
  build: 1,
  scale: 2,
  enterprise: 3,
};

export interface EntitlementRow {
  capability: string;
  domain: string;
  packId: string;
  packTier: "free" | "premium";
  minPlanTier: PlanTier | null;
  /** Whether the org's current plan satisfies minPlanTier (true when none). */
  planSatisfied: boolean;
}

export function deriveEntitlementRows(
  rows: readonly CapabilityRegistrySummary[],
  orgTier: PlanTier,
): EntitlementRow[] {
  const out: EntitlementRow[] = [];
  for (const row of rows) {
    if (!row.plugin) continue;
    const min = row.plugin.minPlanTier;
    out.push({
      capability: row.name,
      domain: row.domain,
      packId: row.plugin.id,
      packTier: row.plugin.tier,
      minPlanTier: min,
      planSatisfied: min === null || TIER_ORDER[orgTier] >= TIER_ORDER[min],
    });
  }
  out.sort(
    (a, b) =>
      a.packId.localeCompare(b.packId) ||
      a.capability.localeCompare(b.capability),
  );
  return out;
}
