/**
 * credit-gate.ts
 *
 * Pre-turn credit admission gate for the chat stream route.
 *
 * WHY this exists — closing the free-ride:
 *
 * `assertCanStartTurn(orgId)` is the platform's single admission gate. It is
 * already wired into EVERY `contract.invoke()` (via bootstrapBillingRuntime →
 * setBillingAdmissionGate in the kernel), so every scoped, metered TOOL call an
 * agent makes is refused for a suspended or zero-balance org. But the chat
 * route's top-level model turn reaches `streamAgentReply` as a
 * direct `@oxagen/ai` streaming call, NOT a `contract.invoke()` — so a turn that
 * makes no tool call (a pure Q&A response) skipped the balance check entirely
 * and a zero-balance org got a full model call for free. This gate closes that
 * window by running the SAME `assertCanStartTurn` before the model turn begins.
 *
 * WHY it is safe (never a false lockout):
 *   - It blocks ONLY on the two AFFIRMATIVE billing outcomes:
 *       · InsufficientCreditsError — thrown only when effectiveBalance <= 0
 *         AFTER any auto-reload attempt (assertCanStartTurn calls maybeAutoReload
 *         first, so an org that would top up is NOT blocked).
 *       · BillingSuspendedError — thrown only when dunningState === 'suspended'.
 *     Both are affirmative "this org must not spend" states. Every org is created
 *     with a non-expiring $5 Free signup grant (grantFreeCredits), so a zero
 *     effective balance means *depleted*, never *billing-absent*.
 *   - It is byte-consistent with the invoke() gate that already governs the same
 *     route: it can never refuse a turn the tool-call gate would have admitted,
 *     and it introduces no new lockout class.
 *   - Any NON-billing failure (a metering-infra/DB hiccup inside the gate)
 *     resolves to `{ ok: true }` — FAIL OPEN. A transient telemetry blip must
 *     never block a paying customer's turn; any tool call within the turn is
 *     still guarded by the invoke() admission gate as a backstop.
 *
 * The route maps `{ ok: false }` to a structured HTTP 402 (Payment Required)
 * before any streaming begins. This module keeps the classify-and-map logic
 * testable in isolation (route.ts is excluded from coverage), mirroring
 * page-context.ts.
 */

import {
  assertCanStartTurn,
  InsufficientCreditsError,
  BillingSuspendedError,
} from "@oxagen/billing";

/** The 402 error codes surfaced to the client — match errorMiddleware's billing shape. */
export type CreditGateDenyCode = "insufficient_credits" | "billing_suspended";

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
): Promise<CreditGateResult> {
  try {
    await assertCanStartTurn(orgId);
    return { ok: true };
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, code: "insufficient_credits", message: err.message };
    }
    if (err instanceof BillingSuspendedError) {
      return { ok: false, code: "billing_suspended", message: err.message };
    }
    // Unknown / infra error — FAIL OPEN. Do not block the turn on a metering
    // blip; the invoke() admission gate still guards any tool call in the turn.
    return { ok: true };
  }
}
