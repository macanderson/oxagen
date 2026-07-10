/**
 * reseller-pricing.ts — the pure math of the re-bill loop: attribute a disjoint
 * usage slice to a customer, and price it under that customer's plan. No I/O, so
 * every branch is exhaustively unit-testable and the money math is auditable in
 * one place.
 */

export type ResellerMatchKind = "workspace" | "principal" | "capability";
export type ResellerPricingMode = "markup" | "per_unit";

/** A price plan's rate, independent of its identity/name. */
export interface PricePlanRate {
  pricingMode: ResellerPricingMode;
  /** Basis points of markup over raw cost (markup mode). */
  markupBps: number | null;
  /** Flat cents per metered unit (per_unit mode). */
  unitPriceCents: number | null;
}

/** An attribution rule, reduced to what matching needs. */
export interface AttributionRuleMatch {
  /** The customer this rule bills to (id opaque to the matcher). */
  customerId: string;
  matchKind: ResellerMatchKind;
  matchValue: string;
  /** Lower runs first. */
  priority: number;
}

/** The joint key of a disjoint usage slice the matcher evaluates rules against. */
export interface UsageSliceKey {
  workspaceId: string;
  principalId: string;
  capabilityName: string;
}

/**
 * micro-USD → whole cents, rounded half-up. 1 USD = 1_000_000 micros = 100
 * cents, so 1 cent = 10_000 micros. Rounding once here keeps every downstream
 * total in whole cents (Stripe's unit) and avoids fractional-cent drift.
 */
export function microsToCents(micros: number): number {
  return Math.round(micros / 10_000);
}

/**
 * The field of `slice` a rule of `kind` compares against its match value.
 * Centralised so the matcher and any diagnostics agree on the mapping.
 */
export function sliceFieldForKind(
  slice: UsageSliceKey,
  kind: ResellerMatchKind,
): string {
  switch (kind) {
    case "workspace":
      return slice.workspaceId;
    case "principal":
      return slice.principalId;
    case "capability":
      return slice.capabilityName;
  }
}

/**
 * Return the first rule (lowest priority number) whose dimension value equals
 * the slice's corresponding field, or null when none matches (the slice is
 * unattributed). Rules are sorted defensively by priority ascending, then—for a
 * stable, deterministic tie-break—by matchValue. Generic so callers get the full
 * rule back (e.g. its label) alongside the match, not just the customer id.
 */
export function matchRuleForSlice<T extends AttributionRuleMatch>(
  slice: UsageSliceKey,
  rules: readonly T[],
): T | null {
  const sorted = [...rules].sort(
    (a, b) =>
      a.priority - b.priority || a.matchValue.localeCompare(b.matchValue),
  );
  for (const rule of sorted) {
    if (sliceFieldForKind(slice, rule.matchKind) === rule.matchValue) {
      return rule;
    }
  }
  return null;
}

/**
 * The customerId of the first matching rule, or null. Thin wrapper over
 * {@link matchRuleForSlice} for callers that only need attribution, not the rule.
 */
export function matchCustomerForSlice(
  slice: UsageSliceKey,
  rules: readonly AttributionRuleMatch[],
): string | null {
  return matchRuleForSlice(slice, rules)?.customerId ?? null;
}

/**
 * Price a customer's attributed usage under a plan.
 * - markup:   round(rawCostCents × (10000 + markupBps) / 10000) — margin over cost.
 * - per_unit: unitPriceCents × quantity — a flat menu price, cost-independent.
 *
 * A null plan is a pass-through at raw cost (an unpriced customer cannot be
 * pushed; this only makes a preview render sensibly). markupBps/unitPriceCents
 * default to 0 defensively so a malformed plan bills zero rather than NaN.
 */
export function priceAttributedUsage(
  rawCostCents: number,
  quantity: number,
  plan: PricePlanRate | null,
): number {
  if (!plan) return rawCostCents;
  if (plan.pricingMode === "markup") {
    const bps = plan.markupBps ?? 0;
    return Math.round((rawCostCents * (10_000 + bps)) / 10_000);
  }
  const unit = plan.unitPriceCents ?? 0;
  return unit * Math.max(0, quantity);
}
