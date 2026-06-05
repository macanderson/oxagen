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
  CONSUME_EXECUTION: "consume_execution",
  CONSUME_TOOL_CALL: "consume_tool_call",
  CONSUME_TOKEN_OVERAGE: "consume_token_overage",
  REFUND: "refund",
  CLAWBACK_DISPUTE: "clawback_dispute",
  ADJUSTMENT: "adjustment",
} as const;

export type CreditReason = (typeof CREDIT_REASONS)[keyof typeof CREDIT_REASONS];
