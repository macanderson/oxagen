import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";

/**
 * Pure metric derivations for the Governance hub board — computed from the
 * capability registry read so every card is grounded in the live contract
 * catalog (no hand-maintained counts).
 */

export interface ChainMetrics {
  /** Total registered contracts. */
  totalContracts: number;
  /** Contracts promising a human-operable app surface (`app` layer). */
  appCovered: number;
  /** Contracts with tenant-scope enforcement (`scoped`). */
  scoped: number;
  /** Contracts that pass the billing admission gate (metered/credit-gated). */
  billingGated: number;
  /** Contracts gated behind a capability-pack entitlement. */
  entitlementGated: number;
  /** Contracts declaring e2e verification evidence. */
  e2eVerified: number;
  /** Contracts declaring unit verification evidence. */
  unitVerified: number;
  /** Contracts declaring an audit-target binding. */
  auditBound: number;
}

export function computeChainMetrics(
  rows: readonly CapabilityRegistrySummary[],
): ChainMetrics {
  let appCovered = 0;
  let scoped = 0;
  let billingGated = 0;
  let entitlementGated = 0;
  let e2eVerified = 0;
  let unitVerified = 0;
  let auditBound = 0;
  for (const row of rows) {
    if (row.layers.includes("app")) appCovered += 1;
    if (row.scoped) scoped += 1;
    if (!row.noBillingGate) billingGated += 1;
    if (row.plugin) entitlementGated += 1;
    if (row.layers.includes("e2e")) e2eVerified += 1;
    if (row.layers.includes("unit")) unitVerified += 1;
    if (row.auditTargetKind) auditBound += 1;
  }
  return {
    totalContracts: rows.length,
    appCovered,
    scoped,
    billingGated,
    entitlementGated,
    e2eVerified,
    unitVerified,
    auditBound,
  };
}

/**
 * Audit reads are page-bounded, so when the page is full and more rows
 * exist the true total is unknown — show "N+" instead of a wrong count.
 */
export function formatCappedCount(count: number, hasMore: boolean): string {
  return hasMore ? `${count}+` : String(count);
}
