// security-event-types.ts — THE single source of truth for the SOC2 audit
// event taxonomy.
//
// Historically this const-union was copy-pasted in three places:
//   - packages/database/src/schema/security.ts   (Drizzle CHECK constraint)
//   - packages/telemetry/src/security.ts          (emit-helper input type)
//   - the migration SQL CHECK constraint DDL
// Adding an event type meant a three-way manual sync; one copy always drifted.
//
// Now `@oxagen/database` and `@oxagen/telemetry` both import from here, and the
// DB CHECK clause is generated programmatically from this array (see db-check.ts).
// Adding a new event type = one edit, in this file. The drift tests in
// @oxagen/compliance and @oxagen/database fail closed if the migration falls
// out of sync.
//
// RULES (do not relax):
//   - Group values by domain (auth / api_key / billing / capability / org);
//     within a group, order by lifecycle, not alphabetically.
//   - Never remove a value that has ever shipped — audit rows referencing it
//     must remain readable. Deprecate in comments instead.
//   - Names are `<domain>.<event>`; outcomes live in SECURITY_OUTCOMES, not here.

// ---------------------------------------------------------------------------
// SECURITY_EVENT_TYPES — typed const-union.
// ---------------------------------------------------------------------------

export const SECURITY_EVENT_TYPES = [
  // Auth lifecycle
  "auth.sign_in",
  "auth.sign_in_failed",
  "auth.sign_out",
  "auth.token_refreshed",
  "auth.password_changed",
  "auth.email_verified",
  // API key lifecycle
  "api_key.created",
  "api_key.revoked",
  "api_key.used",
  // Billing mutations
  "billing.access_denied",
  "billing.auto_reload_updated",
  "billing.credits_purchased",
  "billing.payment_method_added",
  "billing.payment_method_default_changed",
  "billing.payment_method_removed",
  "billing.plan_changed",
  "billing.seats_changed",
  "billing.subscription_canceled",
  "billing.subscription_reactivated",
  // Capability authz
  "capability.invoke_allowed",
  "capability.invoke_denied",
  "capability.invoke_error",
  // Admin / org management
  "org.member_invited",
  "org.member_removed",
  "org.role_changed",
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// SECURITY_OUTCOMES — the authz / lifecycle outcome set. Mirrors the
// security_events.outcome CHECK constraint.
// ---------------------------------------------------------------------------

export const SECURITY_OUTCOMES = ["allow", "deny", "error", "success"] as const;

export type SecurityOutcome = (typeof SECURITY_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Membership guards — O(1) lookups for runtime validation at trust boundaries
// (e.g. accepting an event type off the wire before inserting).
// ---------------------------------------------------------------------------

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(SECURITY_EVENT_TYPES);
const OUTCOME_SET: ReadonlySet<string> = new Set(SECURITY_OUTCOMES);

/** Type guard: is `value` a known SecurityEventType? */
export function isSecurityEventType(value: string): value is SecurityEventType {
  return EVENT_TYPE_SET.has(value);
}

/** Type guard: is `value` a known SecurityOutcome? */
export function isSecurityOutcome(value: string): value is SecurityOutcome {
  return OUTCOME_SET.has(value);
}
