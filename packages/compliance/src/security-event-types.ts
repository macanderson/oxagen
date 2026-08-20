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
//   - Group values by domain (auth / api_key / billing / capability / org / plugin);
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
  "billing.checkout_initiated",
  "billing.credits_purchased",
  "billing.payment_method_added",
  "billing.payment_method_default_changed",
  "billing.payment_method_removed",
  "billing.plan_changed",
  "billing.seats_changed",
  "billing.subscription_canceled",
  "billing.subscription_reactivated",
  // Spend-ceiling mutation (set_spend_budget): how much may be spent per
  // period, per scope. Distinct from auto_reload_updated (when to top up).
  "billing.budget_updated",
  // Billing — reseller revenue (BYO-Stripe rebilling): commercial-terms
  // mutations on downstream customers, price plans, attribution rules, the
  // reseller Stripe connection, and invoice pushes (SOC2 CC6.3/CC6.8).
  "billing.reseller_customer_changed",
  "billing.reseller_price_plan_changed",
  "billing.reseller_attribution_rule_changed",
  "billing.reseller_stripe_configured",
  "billing.reseller_rebill_pushed",
  // Capability authz
  "capability.invoke_allowed",
  "capability.invoke_denied",
  "capability.invoke_error",
  // Org lifecycle
  "organization.created",
  "workspace.created",
  // Admin / org management
  "org.member_invited",
  "org.member_removed",
  "org.role_changed",
  // Plugin governance (org-level marketplace administration)
  "plugin.installed",
  "plugin.uninstalled",
  "plugin.enabled_changed",
  "plugin.denylist_added",
  "plugin.denylist_removed",
  // Security policy
  "security.mfa_policy_updated",
  "security.session_revoked",
  // Governed agent runs (docs/specs/run-evidence-ingress/spec.md). These four
  // are INTEGRITY failures, not ordinary denials: each one means some part of
  // the run-evidence chain was contradicted, and none can be produced by
  // legitimate use. `capability.invoke_denied` above still covers a routine
  // policy deny — do not overload these for that.
  //
  //   event_sequence_conflict   two events claimed the same (run_seq) or
  //                             (attempt_id, attempt_seq) with DIFFERENT
  //                             payload digests — the ordered stream forked
  //   forged_decision_reference  a caller supplied an authorization-decision
  //                             reference on a CapabilityContext; that binding
  //                             is platform-created and can never be an input
  //   stale_deny_generation      an operation was evaluated against a
  //                             deny-generation older than the current one —
  //                             a cached allow outlived its invalidation
  //   finalization_grant_misuse  a one-shot finalization grant was presented
  //                             for a different attempt, digest, or capability
  //                             than the seal it was minted for
  "agent_run.event_sequence_conflict",
  "agent_run.forged_decision_reference",
  "agent_run.stale_deny_generation",
  "agent_run.finalization_grant_misuse",
  // Access review
  "access.review_completed",
  "access.member_access_confirmed",
  // Privacy / GDPR
  "privacy.export_requested",
  "privacy.erasure_requested",
  "privacy.org_erasure_requested",
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
