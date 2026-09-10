/**
 * Shared credit-reason constants — single source of truth for the string
 * literals used in credit_ledger.reason.  Both credits.ts (ALLOWED_REASONS
 * gate) and grants.ts (call sites) import from here so that a rename is a
 * compile-time error rather than a silent runtime failure.
 */

export const CREDIT_REASONS = {
  GRANT_SIGNUP: "grant_signup",
  GRANT_PLAN_RENEWAL: "grant_plan_renewal",
  GRANT_PLAN_UPGRADE: "grant_plan_upgrade",
  GRANT_CREDIT_PACK: "grant_credit_pack",
  GRANT_AUTO_RELOAD: "grant_auto_reload",
  GRANT_MANUAL: "grant_manual",
  // ADR-052: `consume_execution` and `consume_tool_call` survive and take on
  // the governed-action meter. `consume_execution` is what the kernel's usage
  // recorder debits under.
  CONSUME_EXECUTION: "consume_execution",
  CONSUME_TOOL_CALL: "consume_tool_call",
  // ADR-052 §4.3: evidence held beyond the included twelve months, priced per
  // GB-month. The only meter that grows with time rather than activity.
  CONSUME_RETENTION: "consume_retention",
  // ADR-053 §3: tokens the in-app agent spent on the PLATFORM key, billed back
  // as their own line. Never written when the organisation's own key paid the
  // vendor, and never repurposed from CONSUME_TOKEN_OVERAGE, which ADR-052
  // retired — a historical row keeps meaning what it meant.
  CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens",
  REFUND: "refund",
  CLAWBACK_DISPUTE: "clawback_dispute",
  ADJUSTMENT: "adjustment",
} as const;

export type CreditReason = (typeof CREDIT_REASONS)[keyof typeof CREDIT_REASONS];

/**
 * Reasons that exist in historical `credit_ledger` rows and may never be
 * written again.
 *
 * ADR-052 retired `consume_token_overage` rather than repurposing it. The
 * distinction is the whole point: repurposing a reason silently changes what
 * every row already carrying it means, and a ledger whose past rows change
 * meaning is not a ledger. Retiring it leaves 2024–2026's token-cost debits
 * saying exactly what they said.
 *
 * These are deliberately NOT in {@link CREDIT_REASONS}, so `consumeCredits`'s
 * allowlist rejects a write with one — the retirement is enforced, not
 * documented. Read paths that need to include historical rows (usage reports,
 * refunds, dispute lookups) import from here.
 */
export const RETIRED_CREDIT_REASONS = {
  /** Pre-ADR-052 token cost × markup. Retired 2026-09-10. */
  CONSUME_TOKEN_OVERAGE: "consume_token_overage",
} as const;

export type RetiredCreditReason =
  (typeof RETIRED_CREDIT_REASONS)[keyof typeof RETIRED_CREDIT_REASONS];

/**
 * Every reason a ledger row can legally CARRY — live plus retired. Use for
 * reads and filters; use {@link CREDIT_REASONS} for writes.
 */
export const HISTORICAL_CREDIT_REASONS = {
  ...CREDIT_REASONS,
  ...RETIRED_CREDIT_REASONS,
} as const;
