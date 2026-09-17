/**
 * turn-credit-gate.ts
 *
 * Pre-turn credit admission gate for every chat streaming surface.
 *
 * WHY this exists — closing the free-ride:
 *
 * The chat route's top-level model turn reaches `streamAgentReply` as a
 * direct `@oxagen/ai` streaming call, NOT a `contract.invoke()`, so a turn
 * that makes no tool call (a pure Q&A response) would spend the platform key's
 * tokens with no gate in front of it. This gate runs `assertCanStartTurn`
 * — the ADR-053 credit-balance gate for platform-funded assistant tokens —
 * before the model turn begins. It is the credit gate's only surviving
 * caller: the kernel's admission gate for governed actions is
 * `assertGauAvailable` (gau-bucket.ts, ADR-055), installed by
 * bootstrapBillingRuntime → setBillingAdmissionGate, and it reads the
 * organisation's month bucket rather than a credit balance.
 *
 * WHY it is safe (never a false lockout):
 *   - It blocks ONLY on the two AFFIRMATIVE billing outcomes:
 *       · InsufficientCreditsError — thrown only when effectiveBalance <= 0
 *         AFTER any auto-reload attempt (assertCanStartTurn calls maybeAutoReload
 *         first, so an org that would top up is NOT blocked).
 *       · BillingSuspendedError — thrown only when dunningState === 'suspended'.
 *     Both are affirmative "this org must not spend" states. Every new org
 *     holds a non-expiring $5 signup grant: `create_org` writes it on the org
 *     transaction (grantSignupCredits) and the deprecated onboarding action
 *     through grantFreeCredits (ADR-055 §13). A zero effective balance means
 *     *nothing left to spend*, never *billing-absent*.
 *   - It is byte-consistent with the invoke() gate that already governs the same
 *     route: it can never refuse a turn the tool-call gate would have admitted,
 *     and it introduces no new lockout class.
 *   - Any NON-billing failure (a metering-infra/DB hiccup inside the gate)
 *     resolves to `{ ok: true }` — FAIL OPEN. A transient telemetry blip must
 *     never block a paying customer's turn; any tool call within the turn is
 *     still guarded by the invoke() admission gate as a backstop.
 *
 * The caller maps `{ ok: false }` to a structured HTTP 402 (Payment Required)
 * before any streaming begins. It lives in `@oxagen/billing` rather than in one
 * app so BOTH chat streaming surfaces (the Next.js route and the REST route)
 * admit turns by the same rule — there is one gate, not one per surface.
 */

import {
  assertCanStartTurn,
  AssistantSpendCapError,
  InsufficientCreditsError,
  BillingSuspendedError,
  type StartTurnOptions,
} from "./metering";

/**
 * The 402 error codes surfaced to the client — match errorMiddleware's billing
 * shape. `assistant_spend_cap` is the third affirmative "must not spend"
 * state (ADR-053 §3): the month's platform-paid assistant cap is used up.
 */
export type CreditGateDenyCode =
  | "insufficient_credits"
  | "billing_suspended"
  | "assistant_spend_cap";

export type CreditGateResult =
  | { ok: true }
  | { ok: false; code: CreditGateDenyCode; message: string };

/**
 * Evaluate the pre-turn credit admission gate for `orgId`. Never throws —
 * returns a typed result the route maps to a 402. Blocks ONLY on the two
 * affirmative billing errors; fails OPEN on anything else (see module docstring).
 *
 * MUST be called inside a tenant scope (runInTenantScope) — the underlying
 * effectiveBalance / assertOrgCanConsume reads use withTenantDb so RLS stays
 * load-bearing.
 */
export async function evaluateTurnCreditGate(
  orgId: string,
  opts: StartTurnOptions = {},
): Promise<CreditGateResult> {
  try {
    await assertCanStartTurn(orgId, opts);
    return { ok: true };
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, code: "insufficient_credits", message: err.message };
    }
    if (err instanceof BillingSuspendedError) {
      return { ok: false, code: "billing_suspended", message: err.message };
    }
    if (err instanceof AssistantSpendCapError) {
      return { ok: false, code: "assistant_spend_cap", message: err.message };
    }
    // Unknown / infra error — FAIL OPEN. Do not block the turn on a metering
    // blip; the invoke() admission gate still guards any tool call in the turn.
    return { ok: true };
  }
}
