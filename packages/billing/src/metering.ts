import { and, eq, gte, sql } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { consumeCredits, effectiveBalance } from "./credits";
import { CREDIT_REASONS, type CreditReason } from "./constants";
import { getOrgBillingSettings } from "./billing-settings";
import {
  providerCostUsd,
  resolveMeterMarkup,
  resolveRateEntry,
  CREDIT_VALUE_USD,
  MICRO_CREDITS_PER_CREDIT,
  type RateCard,
  type TokenUsageInput,
} from "./pricing";
import { assertOrgCanConsume, BillingSuspendedError } from "./dunning";
import { maybeAutoReload } from "./autoreload";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Admission gate: the pre-turn guard
// ---------------------------------------------------------------------------

export class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits" as const;

  constructor() {
    super(
      "Insufficient credits: your balance is empty. Please add credits to continue.",
    );
    this.name = "InsufficientCreditsError";
  }
}

/**
 * ADR-053 §3: the organisation has spent its monthly cap of assistant tokens
 * on the platform key. Refused before the turn starts, and the message names
 * the cap and the two ways out, because the person reading it is the one who
 * can take either.
 */
export class AssistantSpendCapError extends Error {
  readonly code = "assistant_spend_cap" as const;
  readonly capCents: number;
  readonly spentCents: number;

  constructor(capCents: number, spentCents: number) {
    super(
      `Assistant spend cap reached: this organisation has used ${spentCents} of its ${capCents} credits of platform-paid assistant usage this month. Raise the cap in billing settings, or add your own model API key so the assistant runs on it.`,
    );
    this.name = "AssistantSpendCapError";
    this.capCents = capCents;
    this.spentCents = spentCents;
  }
}

/** First instant of the current calendar month, UTC — the cap's window. */
export function assistantSpendWindowStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Credits the platform key has spent on this organisation's assistant turns
 * since the start of the month: the sum of `consume_assistant_tokens` debits.
 * A debit is negative in the ledger, so the sum is negated. Reads through
 * withTenantDb, so the caller must be inside a tenant scope.
 */
export async function assistantSpendThisMonth(orgId: string): Promise<bigint> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        spent: sql<string>`COALESCE(-SUM(${schema.creditLedger.deltaCents}), 0)`,
      })
      .from(schema.creditLedger)
      .where(
        and(
          eq(schema.creditLedger.orgId, orgId),
          eq(
            schema.creditLedger.reason,
            CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
          ),
          gte(schema.creditLedger.createdAt, assistantSpendWindowStart()),
        ),
      ),
  );
  return BigInt(rows[0]?.spent ?? "0");
}

/**
 * Refuse a platform-paid assistant turn once the organisation's monthly cap is
 * spent (ADR-053 §3). A `null` cap means no cap. Called only when the platform
 * key would pay; an organisation on its own key never reaches it.
 */
export async function assertUnderAssistantSpendCap(
  orgId: string,
): Promise<void> {
  const settings = await getOrgBillingSettings(orgId);
  const cap = settings.assistantSpendCapCents;
  if (cap === null) return;
  const spent = await assistantSpendThisMonth(orgId);
  if (spent >= BigInt(cap)) {
    logger.warn(
      { orgId, capCents: cap, spentCents: Number(spent) },
      "billing: assertCanStartTurn — assistant spend cap reached, refusing turn",
    );
    throw new AssistantSpendCapError(cap, Number(spent));
  }
}

/** Who pays the vendor for a turn's tokens (ADR-053 §2). */
export type TurnFunding = "platform" | "org";

export interface StartTurnOptions {
  /**
   * `platform` (the default) adds the assistant spend cap to the gate; `org`
   * means the organisation's own key pays the vendor, so the cap does not
   * apply. The credit gate itself runs either way: governed tool calls still
   * consume credits under ADR-052 whoever pays for tokens.
   */
  fundedBy?: TurnFunding;
}

export { BillingSuspendedError };

/**
 * The single pre-turn admission gate. Must be called before any AI model call
 * begins so suspended or zero-balance orgs are refused before tokens are spent.
 *
 * Order:
 *   1. assertOrgCanConsume → throws BillingSuspendedError when dunningState==='suspended'
 *   2. maybeAutoReload     → charges and grants credits if balance is low and auto-reload enabled
 *   3. effectiveBalance    → after any auto-reload, if still 0, throw InsufficientCreditsError
 *   4. assistant spend cap → for a platform-funded turn only, throw
 *                            AssistantSpendCapError once the month's cap is spent (ADR-053 §3)
 */
export async function assertCanStartTurn(
  orgId: string,
  opts: StartTurnOptions = {},
): Promise<void> {
  const start = Date.now();
  const fundedBy: TurnFunding = opts.fundedBy ?? "platform";

  // Step 1: refuse suspended orgs immediately.
  await assertOrgCanConsume(orgId);

  // Step 2: try auto-reload if balance is low. BEST-EFFORT — a reload failure
  // (Stripe/DB hiccup) must never block the turn or surface as an unclassified
  // error; the balance check below is the real gate and will refuse cleanly
  // with InsufficientCreditsError if no credits ended up available.
  try {
    await maybeAutoReload(orgId);
  } catch (err) {
    logger.error(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "billing: assertCanStartTurn — auto-reload threw, continuing to balance check",
    );
  }

  // Step 3: require a positive balance after any reload attempt.
  const balance = await effectiveBalance(orgId);
  if (balance <= 0n) {
    logger.warn(
      { orgId, balanceCents: 0, durationMs: Date.now() - start },
      "billing: assertCanStartTurn — insufficient credits, refusing turn",
    );
    throw new InsufficientCreditsError();
  }

  // Step 4: a turn the platform key would pay for is held to the org's cap.
  if (fundedBy === "platform") {
    await assertUnderAssistantSpendCap(orgId);
  }

  logger.debug(
    {
      orgId,
      fundedBy,
      balanceCents: Number(balance),
      durationMs: Date.now() - start,
    },
    "billing: assertCanStartTurn — admitted",
  );
}

/**
 * The cost meter. Converts one metered call into (a) the provider cost incurred
 * and (b) the credits to debit, then charges them.
 *
 * **Under ADR-052 this is a REPORT for almost every caller.** Tokens are priced
 * in full and billed at zero, because under vendor-neutral BYOK the customer
 * settled that invoice with the provider directly and a markup would be margin
 * on a cost Oxagen never bore. The primary meter is the governed action —
 * `action-metering.ts`, driven from the kernel's usage recorder.
 *
 * ADR-053 §3 amends that for exactly one case: tokens the in-app agent spent on
 * the PLATFORM key are a cost Oxagen did bear, and are billed back at vendor
 * cost plus the published markup under `consume_assistant_tokens`. Every
 * surviving caller of the charge path is gated on `fundedBy === "platform"`,
 * which is why {@link resolveMeterMarkup} still exists — it is the ADR-053
 * markup now, and it has no other charging caller. Inputs are exactly what providers bill on — tokens in/out for text,
 * images/seconds for media — so the meter matches the real invoice.
 *
 * Text, image, and video all funnel through one DB-charging chokepoint
 * ({@link chargeCostUsd}) so the markup → credits → atomic-debit path is solved
 * once. Only the per-modality cost derivation differs.
 */

/**
 * What one call is worth, in MICRO-credits — the meter's exact answer, with no
 * rounding to the ledger's unit.
 *
 * The ledger holds whole credits and one credit is a cent, so a call worth a
 * fraction of a cent cannot be debited as itself. Rounding that fraction up per
 * call charged a 200-token embedding 739x its cost (#1413), and the platform
 * makes one embedding call per ingested entity. So the rounding decision is not
 * made here: {@link chargeUsageCredits} hands this number to `consumeCredits`,
 * which banks the sub-credit remainder against the org and debits a whole
 * credit once the fractions add up to one. Exact over a sequence of calls.
 */
export function microCreditsForCostUsd(
  costUsd: number,
  markup: number = resolveMeterMarkup(),
): bigint {
  const micros =
    ((costUsd * markup) / CREDIT_VALUE_USD) * Number(MICRO_CREDITS_PER_CREDIT);
  return micros <= 0 ? 0n : BigInt(Math.round(micros));
}

/**
 * Credits one call is worth on its own: ceil(costUsd × markup ÷ creditValue).
 *
 * An UPPER BOUND for display — a quote, a per-turn credit readout — not the
 * amount debited. The debit is {@link microCreditsForCostUsd} carried across
 * calls, so for a small call this reads 1 where the charge is a fraction of
 * that. The two agree whenever a call is worth a whole credit or more.
 */
export function creditsForCostUsd(
  costUsd: number,
  markup: number = resolveMeterMarkup(),
): bigint {
  const creditsExact = (costUsd * markup) / CREDIT_VALUE_USD;
  return creditsExact <= 0 ? 0n : BigInt(Math.ceil(creditsExact));
}

/**
 * Credits a token call is worth on its own, rounded up — the display figure.
 * {@link creditsForCostUsd} explains why the debit can be smaller.
 *
 * Pass the SAME `usage` shape the real charge uses. `cachedTokens` and
 * `cacheWriteTokens` are subsets of `inputTokens` billed at their own rates, so
 * omitting them prices every cached and cache-write token as fresh input and
 * returns a number that does not match what {@link chargeUsageCredits} debits.
 * Callers that show this figure to a user must pass all four fields.
 */
export function meterCreditsForUsage(
  usage: TokenUsageInput,
  opts: { markup?: number; rateCard?: RateCard } = {},
): bigint {
  return creditsForCostUsd(
    providerCostUsd(usage, opts.rateCard),
    opts.markup ?? resolveMeterMarkup(),
  );
}

export interface ChargeUsageResult {
  /** Provider cost in micro-USD — write straight to token_usage.cost_usd_micros. */
  costUsdMicros: number;
  /**
   * Whole credits this call came to owe — the debit plus anything the balance
   * could not cover. Zero when the call was worth less than a credit and its
   * value went to the org's carry instead; {@link creditsForCostUsd} is the
   * per-call figure to show a user.
   */
  creditsMetered: bigint;
  /** Credits actually debited (clamped to the available balance). */
  creditsCharged: bigint;
  /** Metered − charged. Non-zero only when the balance was exhausted. */
  shortfallCredits: bigint;
  /**
   * True when no rate-card row priced this model, so the charge came from
   * {@link FALLBACK_RATE_MODEL} rather than from the model's own rate. The
   * amount is a guess in an unknown direction — consumers that treat
   * `costUsdMicros` as fact must not, for this call.
   */
  rateCardMiss: boolean;
}

/**
 * The single DB-charging chokepoint for every modality. Given a model and the
 * USD cost a call incurred, applies the solved meter markup, converts to
 * credits, and debits them via the atomic {@link consumeCredits} (reason
 * `consume_assistant_tokens`), which row-locks the balance and clamps the debit to
 * what's available — credit_balances enforces `balance_cents >= 0` (no
 * overdraft). A non-zero `shortfallCredits` means the org outran its credits
 * mid-turn; the pre-turn guard ({@link assertCanStartTurn}) is the real
 * admission gate. May throw on a DB failure — callers invoke it best-effort
 * (try/catch in the gate) so metering never fails the user's turn.
 *
 * Instrumentation: logs orgId, model, costUsdMicros, creditsMetered/charged,
 * shortfall, durationMs, plus any modality-specific `logFields`, on every call.
 */
async function chargeCostUsd(params: {
  orgId: string;
  model: string;
  costUsd: number;
  referenceId?: string;
  markup?: number;
  /** True when the rate came from the fallback because no card row matched. */
  rateCardMiss?: boolean;
  /**
   * Ledger reason. Required, not defaulted: the old default was
   * `consume_token_overage`, which ADR-052 retired and ADR-053 says must not be
   * repurposed — and the assistant spend cap sums `consume_assistant_tokens`
   * alone, so a defaulted debit was invisible to the cap meant to bound it.
   */
  reason: CreditReason;
  logFields?: Record<string, unknown>;
}): Promise<ChargeUsageResult> {
  const start = Date.now();
  const costUsdMicros = Math.round(params.costUsd * 1_000_000);
  const rateCardMiss = params.rateCardMiss ?? false;

  // A miss debits real credits at another model's rate, in an unknown
  // direction — cheap models are over-charged, expensive ones are sold below
  // cost. Nothing downstream can tell a guessed rate from a measured one, so
  // this is the only place it is visible. Alert rather than refuse: refusing
  // would bill the call at zero, which is the worse of the two errors.
  if (rateCardMiss) {
    logger.error(
      {
        orgId: params.orgId,
        model: params.model,
        costUsdMicros,
        alert: "billing_rate_card_miss",
      },
      "billing: meter — no rate-card row for this model; charged at the fallback rate, amount is a guess",
    );
  }
  // Meter in micro-credits and let consumeCredits carry the fraction, so a call
  // worth less than a credit is not rounded up to one (#1413).
  const microCredits = microCreditsForCostUsd(
    params.costUsd,
    params.markup ?? resolveMeterMarkup(),
  );
  if (microCredits <= 0n) {
    logger.debug(
      {
        orgId: params.orgId,
        model: params.model,
        costUsdMicros,
        creditsMetered: 0,
        durationMs: Date.now() - start,
      },
      "billing: meter — zero cost call, no charge",
    );
    return {
      costUsdMicros,
      creditsMetered: 0n,
      creditsCharged: 0n,
      shortfallCredits: 0n,
      rateCardMiss,
    };
  }

  const { chargedCents, shortfallCents, carryMicroCents } =
    await consumeCredits({
      orgId: params.orgId,
      requestedMicroCents: microCredits,
      reason: params.reason,
      referenceType: "token_usage",
      referenceId: params.referenceId,
    });
  // What this call actually owed in whole credits, after the carry: the debit
  // plus anything the balance could not cover.
  const creditsMetered = chargedCents + shortfallCents;

  logger.info(
    {
      orgId: params.orgId,
      model: params.model,
      ...(params.logFields ?? {}),
      costUsdMicros,
      creditsMetered: Number(creditsMetered),
      creditsCharged: Number(chargedCents),
      shortfallCredits: Number(shortfallCents),
      microCredits: Number(microCredits),
      carryMicroCents: Number(carryMicroCents),
      referenceId: params.referenceId ?? null,
      rateCardMiss,
      durationMs: Date.now() - start,
    },
    "billing: meter — usage charged",
  );

  return {
    costUsdMicros,
    creditsMetered,
    creditsCharged: chargedCents,
    shortfallCredits: shortfallCents,
    rateCardMiss,
  };
}

export interface ChargeUsageArgs extends TokenUsageInput {
  orgId: string;
  /** Correlation id — the execution step / message id that drove the call. */
  referenceId?: string;
  /** Optional markup override (tests / dry-run). */
  markup?: number;
  rateCard?: RateCard;
  /**
   * Ledger reason. Required, not defaulted — see `chargeCostUsd`'s field for
   * why a default here was a trap.
   */
  reason: CreditReason;
}

/** Charge an org for one metered TEXT (token) call. */
export async function chargeUsageCredits(
  args: ChargeUsageArgs,
): Promise<ChargeUsageResult> {
  return chargeCostUsd({
    orgId: args.orgId,
    model: args.model,
    costUsd: providerCostUsd(args, args.rateCard),
    referenceId: args.referenceId,
    markup: args.markup,
    reason: args.reason,
    rateCardMiss:
      resolveRateEntry(args.model, args.rateCard).matchedKey === null,
    logFields: {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cachedTokens: args.cachedTokens ?? 0,
      cacheWriteTokens: args.cacheWriteTokens ?? 0,
    },
  });
}

/**
 * True when the org has any non-expired credits left — the pre-turn admission
 * check. Reads the effective balance from lots (lazy expiry) rather than the
 * cached credit_balances mirror so it is always authoritative.
 */
export async function hasCreditBalance(orgId: string): Promise<boolean> {
  return (await effectiveBalance(orgId)) > 0n;
}
