import { consumeCredits, effectiveBalance } from "./credits";
import {
  providerCostUsd,
  imageProviderCostUsd,
  videoProviderCostUsd,
  resolveMeterMarkup,
  CREDIT_VALUE_USD,
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

export { BillingSuspendedError };

/**
 * The single pre-turn admission gate. Must be called before any AI model call
 * begins so suspended or zero-balance orgs are refused before tokens are spent.
 *
 * Order:
 *   1. assertOrgCanConsume → throws BillingSuspendedError when dunningState==='suspended'
 *   2. maybeAutoReload     → charges and grants credits if balance is low and auto-reload enabled
 *   3. effectiveBalance    → after any auto-reload, if still 0, throw InsufficientCreditsError
 */
export async function assertCanStartTurn(orgId: string): Promise<void> {
  const start = Date.now();

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

  logger.debug(
    { orgId, balanceCents: Number(balance), durationMs: Date.now() - start },
    "billing: assertCanStartTurn — admitted",
  );
}

/**
 * The cost meter that lives inside the gate. Converts one metered call into
 * (a) the provider cost we incurred and (b) the credits to debit, then charges
 * them. Inputs are exactly what providers bill on — tokens in/out for text,
 * images/seconds for media — so the meter stays honest against the invoice.
 *
 * Text, image, and video all funnel through one DB-charging chokepoint
 * ({@link chargeCostUsd}) so the markup → credits → atomic-debit path is solved
 * once. Only the per-modality cost derivation differs.
 */

/** Credits to debit for a known provider cost: ceil(costUsd × markup ÷ creditValue). */
export function creditsForCostUsd(
  costUsd: number,
  markup: number = resolveMeterMarkup(),
): bigint {
  const creditsExact = (costUsd * markup) / CREDIT_VALUE_USD;
  return creditsExact <= 0 ? 0n : BigInt(Math.ceil(creditsExact));
}

/** Credits to debit for a token call: ceil(providerCostUsd × markup ÷ creditValue). */
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
  /** Credits the meter says this call is worth. */
  creditsMetered: bigint;
  /** Credits actually debited (clamped to the available balance). */
  creditsCharged: bigint;
  /** Metered − charged. Non-zero only when the balance was exhausted. */
  shortfallCredits: bigint;
}

/**
 * The single DB-charging chokepoint for every modality. Given a model and the
 * USD cost a call incurred, applies the solved meter markup, converts to
 * credits, and debits them via the atomic {@link consumeCredits} (reason
 * `consume_token_overage`), which row-locks the balance and clamps the debit to
 * what's available — credit_balances enforces `balance_cents >= 0` (no
 * overdraft). A non-zero `shortfallCredits` means the org outran its credits
 * mid-turn; the pre-turn guard ({@link hasCreditBalance}) is the real admission
 * gate. May throw on a DB failure — callers invoke it best-effort (try/catch in
 * the gate) so metering never fails the user's turn.
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
  logFields?: Record<string, unknown>;
}): Promise<ChargeUsageResult> {
  const start = Date.now();
  const costUsdMicros = Math.round(params.costUsd * 1_000_000);
  const creditsMetered = creditsForCostUsd(
    params.costUsd,
    params.markup ?? resolveMeterMarkup(),
  );
  if (creditsMetered <= 0n) {
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
    };
  }

  const { chargedCents, shortfallCents } = await consumeCredits({
    orgId: params.orgId,
    requestedCents: creditsMetered,
    reason: "consume_token_overage",
    referenceType: "token_usage",
    referenceId: params.referenceId,
  });

  logger.info(
    {
      orgId: params.orgId,
      model: params.model,
      ...(params.logFields ?? {}),
      costUsdMicros,
      creditsMetered: Number(creditsMetered),
      creditsCharged: Number(chargedCents),
      shortfallCredits: Number(shortfallCents),
      referenceId: params.referenceId ?? null,
      durationMs: Date.now() - start,
    },
    "billing: meter — usage charged",
  );

  return {
    costUsdMicros,
    creditsMetered,
    creditsCharged: chargedCents,
    shortfallCredits: shortfallCents,
  };
}

export interface ChargeUsageArgs extends TokenUsageInput {
  orgId: string;
  /** Correlation id — the execution step / message id that drove the call. */
  referenceId?: string;
  /** Optional markup override (tests / dry-run). */
  markup?: number;
  rateCard?: RateCard;
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
    logFields: {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cachedTokens: args.cachedTokens ?? 0,
      cacheWriteTokens: args.cacheWriteTokens ?? 0,
    },
  });
}

export interface ChargeImageArgs {
  orgId: string;
  /** Gateway model id (creator/model form), e.g. "bfl/flux-2-max". */
  model: string;
  /** Number of images generated. */
  imageCount: number;
  /** Size string the generator used, e.g. "1024x1024" — drives HD multipliers. */
  size?: string;
  referenceId?: string;
  markup?: number;
}

/** Charge an org for one metered IMAGE call (per-image pricing). */
export async function chargeImageCredits(
  args: ChargeImageArgs,
): Promise<ChargeUsageResult> {
  return chargeCostUsd({
    orgId: args.orgId,
    model: args.model,
    costUsd: imageProviderCostUsd(args.model, args.imageCount, args.size),
    referenceId: args.referenceId,
    markup: args.markup,
    logFields: { imageCount: args.imageCount, size: args.size ?? null },
  });
}

export interface ChargeVideoArgs {
  orgId: string;
  /** Gateway model id (creator/model form), e.g. "google/veo-3.0-generate-001". */
  model: string;
  /** Clip length in seconds (drives per-second pricing). */
  durationSeconds?: number;
  referenceId?: string;
  markup?: number;
}

/** Charge an org for one metered VIDEO call (per-second pricing). */
export async function chargeVideoCredits(
  args: ChargeVideoArgs,
): Promise<ChargeUsageResult> {
  return chargeCostUsd({
    orgId: args.orgId,
    model: args.model,
    costUsd: videoProviderCostUsd(args.model, args.durationSeconds),
    referenceId: args.referenceId,
    markup: args.markup,
    logFields: { durationSeconds: args.durationSeconds ?? null },
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
