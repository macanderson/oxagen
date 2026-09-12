// audit-exempt: read-only — aggregates the governed-action counter, the credit ledger and ClickHouse token_usage for the caller's own org; mutates nothing. The kernel capability.invoke_* audit covers access.
/**
 * get_action_usage handler (ADR-052 §4, spec §7.5).
 *
 * The answer to "why is my bill this number", assembled from four sources and
 * never from an estimate:
 *
 *   - `billing.governed_action_counters` — the one indexed row that IS the
 *     meter. Actions used and actions charged for the entitlement year.
 *   - `billing.plans` via `resolveOrgActionEntitlement` — the tier and the
 *     stored annual allowance.
 *   - `billing.credit_ledger` — what was actually debited, read back rather
 *     than recomputed, so the figure shown is the figure charged.
 *   - ClickHouse `token_usage` — model spend, reported in full and charged at
 *     zero (§4.4).
 *
 * Where a source cannot answer, the field reports zero and the failure is
 * logged. It never substitutes a computed guess for a reading: a usage page
 * whose numbers are derived rather than read is the thing ADR-052 replaced.
 */

import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingActionUsage } from "@oxagen/oxagen/contracts/billing.action_usage";
import { getCapability } from "@oxagen/oxagen";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import {
  CREDIT_REASONS,
  actionPeriodStart,
  priceAnnualVolumeCredits,
  readActionCounter,
  resolveActionAllowance,
  resolveActionBand,
  resolveActionMeterMode,
  resolveOrgActionEntitlement,
} from "@oxagen/billing";
import { sumTokenUsage } from "@oxagen/telemetry";
import { logger } from "./logger";

/** The audit event the kernel emits for a capability invocation that ran. */
const INVOKE_ALLOWED_EVENT = "capability.invoke_allowed";

/**
 * Cap on the per-capability breakdown. An organisation has a few hundred
 * capabilities at most, so this bounds a pathological read without truncating
 * a real answer.
 */
const BREAKDOWN_LIMIT = 250;

/** A ledger delta is negative for a debit; report the magnitude. */
function debitedCredits(sumOfDeltas: bigint): number {
  const magnitude = sumOfDeltas < 0n ? -sumOfDeltas : 0n;
  return Number(magnitude);
}

/**
 * Sum `credit_ledger.delta_cents` for one reason over the period.
 *
 * Live reasons only. `HISTORICAL_CREDIT_REASONS` exists for reads that must
 * span the retirement of `consume_token_overage`, and this is deliberately not
 * one of them: that reason recorded the pre-ADR-052 token meter, which priced a
 * different unit under a different rule. Folding those rows into
 * `creditsCharged` would break the `creditsAtFinalBand` comparison below, whose
 * whole purpose is to reconcile two ways of pricing THE SAME governed actions.
 */
async function sumLedgerDebits(args: {
  orgId: string;
  reason: string;
  referenceType?: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<bigint> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        total: sql<string>`coalesce(sum(${schema.creditLedger.deltaCents}), 0)`,
      })
      .from(schema.creditLedger)
      .where(
        and(
          eq(schema.creditLedger.orgId, args.orgId),
          eq(schema.creditLedger.reason, args.reason),
          args.referenceType === undefined
            ? undefined
            : eq(schema.creditLedger.referenceType, args.referenceType),
          gte(schema.creditLedger.createdAt, args.periodStart),
          lt(schema.creditLedger.createdAt, args.periodEnd),
        ),
      ),
  );
  return BigInt(rows[0]?.total ?? "0");
}

/**
 * Successful capability invocations for the org over the period, by capability.
 *
 * Read from `security.security_events`, which is where the kernel records every
 * invocation that passed its gates and completed — the same event the meter
 * accrues on. It is the ONLY per-capability record of governed activity that
 * exists: the counter is an org-level aggregate, and ClickHouse `token_usage`
 * counts LLM calls, which most capabilities never make.
 *
 * It is an UPPER BOUND on billed actions, not a partition of `actionsUsed`.
 * Capabilities the meter skips are removed here — `noBillingGate` contracts
 * never accrue — but a nested `invoke()` also emits an audit row while the
 * meter charges only the top-level one, and nothing recorded distinguishes the
 * two after the fact. So these rows answer "where is my governance activity
 * going" and will read at or above the billed total; they are not a
 * reconciliation of it. Reporting that honestly beats scaling the rows to make
 * them add up, which would be a fabricated attribution.
 */
async function readActionsByCapability(args: {
  orgId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ capability: string; actions: number }[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        capability: schema.securityEvents.capability,
        actions: sql<string>`count(*)`,
      })
      .from(schema.securityEvents)
      .where(
        and(
          eq(schema.securityEvents.orgId, args.orgId),
          eq(schema.securityEvents.eventType, INVOKE_ALLOWED_EVENT),
          isNotNull(schema.securityEvents.capability),
          gte(schema.securityEvents.occurredAt, args.periodStart),
          lt(schema.securityEvents.occurredAt, args.periodEnd),
        ),
      )
      .groupBy(schema.securityEvents.capability)
      .orderBy(desc(sql`count(*)`))
      .limit(BREAKDOWN_LIMIT),
  );

  const out: { capability: string; actions: number }[] = [];
  for (const row of rows) {
    const name = row.capability;
    if (!name) continue;
    // A contract the meter never charges for must not appear in a bill
    // explainer. An unregistered name is KEPT: this read cannot prove a
    // capability is non-billable just because its contract module is not
    // loaded in this process, and dropping it would hide real activity.
    if (getCapability(name)?.noBillingGate === true) continue;
    const actions = Math.max(0, Math.floor(Number(row.actions)));
    if (actions > 0) out.push({ capability: name, actions });
  }
  return out;
}

export const billingActionUsageHandler: CapabilityHandler<
  typeof billingActionUsage
> = async (input, ctx) => {
  const now = new Date();
  const periodStart = actionPeriodStart(now);
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear() + 1, 0, 1));

  const [counter, entitlement] = await Promise.all([
    readActionCounter(ctx.orgId, now),
    resolveOrgActionEntitlement(ctx.orgId),
  ]);

  const allowance = resolveActionAllowance(
    entitlement.tier,
    entitlement.includedActionsAnnual,
  );
  const actionsUsed = Math.max(0, Math.floor(counter.actionsUsed));
  const actionsCharged = Math.max(0, Math.floor(counter.actionsCharged));
  const actionsWithinAllowance = Math.min(actionsUsed, allowance);
  const actionsRemaining = Math.max(0, allowance - actionsUsed);
  const band = resolveActionBand(actionsUsed);

  // What the ledger actually debited for governed actions, read back rather
  // than recomputed — the number on the statement, not a model of it.
  const creditsCharged = debitedCredits(
    await sumLedgerDebits({
      orgId: ctx.orgId,
      reason: CREDIT_REASONS.CONSUME_EXECUTION,
      referenceType: "governed_action",
      periodStart,
      periodEnd,
    }),
  );

  // ADR-053 §3: tokens the PLATFORM key paid for are the one model-spend line
  // that is billed back. Zero for an organisation on its own key.
  const assistantTokenCredits = debitedCredits(
    await sumLedgerDebits({
      orgId: ctx.orgId,
      reason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
      periodStart,
      periodEnd,
    }),
  );

  // §4.1 as written: the whole period's overage priced at the single band the
  // year-end total lands in. The recorder charged incrementally at the running
  // band, so for a customer who crossed a boundary mid-year this is the smaller
  // figure and the difference is a true-up owed to them.
  const overageActions = Math.max(0, actionsUsed - allowance);
  const creditsAtFinalBand = Number(priceAnnualVolumeCredits(overageActions));
  // Clamped: the contract declares this zero-or-positive, and incremental
  // charging can only ever meet or exceed the single-band price, so a negative
  // here would mean a charge was missed — visible as a zero, not as a credit
  // the customer does not have.
  const bandTrueUpCredits = Math.max(0, creditsCharged - creditsAtFinalBand);

  // Model spend: reported in full, charged at zero (§4.4). ClickHouse is
  // optional in some runtimes and degrades independently of Postgres, so an
  // outage costs this one line rather than the whole answer — but it is logged
  // at warn, because a silent zero here would read as "you spent nothing".
  let reportedCostMicros = 0;
  try {
    const rollup = await sumTokenUsage({
      orgId: ctx.orgId,
      periodStart,
      periodEnd,
    });
    const totalMicros = rollup.reduce((sum, row) => sum + row.costMicros, 0n);
    reportedCostMicros = Math.max(0, Number(totalMicros));
  } catch (err) {
    logger.warn(
      {
        orgId: ctx.orgId,
        err: err instanceof Error ? err.message : String(err),
      },
      "get_action_usage: token-usage rollup unavailable — reporting model spend as 0 rather than estimating it",
    );
  }

  const byCapability = input.includeBreakdown
    ? await readActionsByCapability({
        orgId: ctx.orgId,
        periodStart,
        periodEnd,
      })
    : [];

  logger.info(
    {
      orgId: ctx.orgId,
      surface: ctx.surface,
      periodStart: periodStart.toISOString(),
      tier: entitlement.tier,
      allowance,
      actionsUsed,
      actionsCharged,
      band: band.id,
      creditsCharged,
      creditsAtFinalBand,
      bandTrueUpCredits,
      meterMode: resolveActionMeterMode(),
      breakdownRows: byCapability.length,
    },
    "get_action_usage: returned governed-action usage for the entitlement year",
  );

  return {
    period: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
    },
    actionsUsed,
    actionsIncluded: allowance,
    actionsWithinAllowance,
    actionsCharged,
    actionsRemaining,
    band: { id: band.id, usdPer1000: band.usdPer1000 },
    creditsCharged,
    creditsAtFinalBand,
    bandTrueUpCredits,
    meterMode: resolveActionMeterMode(),
    modelSpend: {
      reportedCostMicros,
      // Always zero. The line exists rather than being omitted (§4.4).
      chargedCredits: 0,
      assistantTokenCredits,
    },
    byCapability,
  };
};
