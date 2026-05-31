import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { consumeCredits } from "./credits.js";
import {
  providerCostUsd,
  providerCostUsdMicros,
  resolveMeterMarkup,
  CREDIT_VALUE_USD,
  type RateCard,
  type TokenUsageInput,
} from "./pricing.js";

/**
 * The cost meter that lives inside the gate. Converts one metered LLM call
 * into (a) the provider cost we incurred and (b) the credits to debit, then
 * charges them. Inputs are exactly what providers bill on — tokens in/out by
 * model — so the meter stays honest against the provider invoice.
 */

/** Credits to debit for a call: ceil(providerCostUsd × markup ÷ creditValue). */
export function meterCreditsForUsage(
  usage: TokenUsageInput,
  opts: { markup?: number; rateCard?: RateCard } = {},
): bigint {
  const markup = opts.markup ?? resolveMeterMarkup();
  const costUsd = providerCostUsd(usage, opts.rateCard);
  const creditsExact = (costUsd * markup) / CREDIT_VALUE_USD;
  return creditsExact <= 0 ? 0n : BigInt(Math.ceil(creditsExact));
}

export interface ChargeUsageArgs extends TokenUsageInput {
  orgId: string;
  /** Correlation id — the execution step / message id that drove the call. */
  referenceId?: string;
  /** Optional markup override (tests / dry-run). */
  markup?: number;
  rateCard?: RateCard;
}

export interface ChargeUsageResult {
  /** Provider cost in micro-USD — write straight to token_usage.cost_usd_micros. */
  costUsdMicros: number;
  /** Credits the meter says this call is worth. */
  creditsMetered: bigint;
  /** Credits actually debited (clamped to the available balance). */
  creditsCharged: bigint;
  /** Metered − charged. Non-zero only when the balance was exhausted. */
  shortfallCredits: bigint;
}

/**
 * Charge an org for one metered call. Delegates to the atomic
 * {@link consumeCredits} (reason `consume_token_overage`), which row-locks the
 * balance and clamps the debit to what's available — credit_balances enforces
 * `balance_cents >= 0` (no overdraft). A non-zero `shortfallCredits` means the
 * org outran its credits mid-turn; the pre-turn guard ({@link hasCreditBalance})
 * is the real admission gate. May throw on a DB failure — callers invoke it
 * best-effort (wrapped in try/catch in the gate) so metering never fails the
 * user's turn.
 */
export async function chargeUsageCredits(args: ChargeUsageArgs): Promise<ChargeUsageResult> {
  const costUsdMicros = providerCostUsdMicros(args, args.rateCard);
  const creditsMetered = meterCreditsForUsage(args, { markup: args.markup, rateCard: args.rateCard });
  if (creditsMetered <= 0n) {
    return { costUsdMicros, creditsMetered: 0n, creditsCharged: 0n, shortfallCredits: 0n };
  }

  const { chargedCents, shortfallCents } = await consumeCredits({
    orgId: args.orgId,
    requestedCents: creditsMetered,
    reason: "consume_token_overage",
    referenceType: "token_usage",
    referenceId: args.referenceId,
  });

  return {
    costUsdMicros,
    creditsMetered,
    creditsCharged: chargedCents,
    shortfallCredits: shortfallCents,
  };
}

/** True when the org has any credits left — the pre-turn admission check. */
export async function hasCreditBalance(orgId: string): Promise<boolean> {
  const d = db();
  const row = await d.query.creditBalances.findFirst({
    where: eq(schema.creditBalances.orgId, orgId),
    columns: { balanceCents: true },
  });
  return (row?.balanceCents ?? 0n) > 0n;
}
