/**
 * entitlements.ts — plan-tier feature gates.
 *
 * ALL gating logic lives here. Every feature check is a pure function of the
 * plan tier so tests never need I/O. Call `resolveOrgTier` to fetch the tier,
 * then pass it to these helpers.
 *
 * Tier ladder:  free < build < scale < enterprise
 *
 * Design invariants:
 *  - Enterprise-only features (ACLs, SSO, SCIM, immutable audit) are gated
 *    strictly on `tier === 'enterprise'`. The other tiers cannot access them
 *    even if explicitly granted by an admin — the tier gate is a hard cap.
 *  - Free users cannot purchase credit packs; they must subscribe first.
 *  - `requireTier` throws a `TierDeniedError` (typed, narrowable) — callers
 *    can catch it and return an appropriate HTTP/MCP error.
 */
import type { PlanTier } from "@oxagen/oxagen/types";

// ── Tier ordering ─────────────────────────────────────────────────────────────

const TIER_ORDER: Record<PlanTier, number> = {
  free: 0,
  build: 1,
  scale: 2,
  enterprise: 3,
};

/** True if `actual` meets or exceeds the `minimum` tier. */
export function meetsMinimumTier(actual: PlanTier, minimum: PlanTier): boolean {
  // Record<PlanTier, number> guarantees both keys exist; the non-null assertion
  // is safe because PlanTier is a closed union and all values are present.
  return TIER_ORDER[actual]! >= TIER_ORDER[minimum]!;
}

// ── TierDeniedError ───────────────────────────────────────────────────────────

/**
 * Thrown by `requireTier` when the org's plan tier is below the minimum
 * required for the requested feature.
 *
 * Callers should catch this, inspect `.code`, and surface an appropriate
 * user-facing message (e.g. HTTP 402 Payment Required or MCP error payload).
 */
export class TierDeniedError extends Error {
  readonly code = "TIER_DENIED" as const;
  readonly actualTier: PlanTier;
  readonly requiredTier: PlanTier;

  constructor(actualTier: PlanTier, requiredTier: PlanTier, feature?: string) {
    const label = feature ? ` (${feature})` : "";
    super(
      `Plan upgrade required${label}: org is on '${actualTier}' but '${requiredTier}' or above is needed`,
    );
    this.name = "TierDeniedError";
    this.actualTier = actualTier;
    this.requiredTier = requiredTier;
  }
}

/** Type guard — true when `err` is a TierDeniedError. */
export function isTierDenied(err: unknown): err is TierDeniedError {
  return err instanceof TierDeniedError;
}

// ── Core gate ─────────────────────────────────────────────────────────────────

/**
 * Assert that `tier` meets or exceeds `minimum`.
 *
 * Throws `TierDeniedError` if the assertion fails. Returns void on success so
 * callers can use it as a precondition check without an explicit branch:
 *
 *   requireTier(ctx.planTier ?? 'free', 'build', 'credit-packs');
 *   // proceeds only if build+ — throws otherwise
 */
export function requireTier(
  tier: PlanTier,
  minimum: PlanTier,
  feature?: string,
): void {
  if (!meetsMinimumTier(tier, minimum)) {
    throw new TierDeniedError(tier, minimum, feature);
  }
}

// ── Feature-specific gates ────────────────────────────────────────────────────

/**
 * Whether the org can use ACL (attribute/role-based access control) features.
 * Enterprise only — enforced at the IAM check layer.
 */
export function canAccessACL(tier: PlanTier): boolean {
  return tier === "enterprise";
}

/**
 * Whether the org can access SSO (SAML/OIDC single sign-on).
 * Enterprise only.
 */
export function canAccessSSO(tier: PlanTier): boolean {
  return tier === "enterprise";
}

/**
 * Whether the org can use SCIM provisioning/deprovisioning.
 * Enterprise only.
 */
export function canAccessSCIM(tier: PlanTier): boolean {
  return tier === "enterprise";
}

/**
 * Whether the org can access the immutable audit log export.
 * Enterprise only.
 */
export function canAccessAuditLog(tier: PlanTier): boolean {
  return tier === "enterprise";
}

/**
 * Whether the org can purchase one-time credit packs.
 * Free orgs cannot buy packs — they must subscribe to Build or above first.
 */
export function canBuyCredits(tier: PlanTier): boolean {
  return tier !== "free";
}
