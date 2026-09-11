// audit-exempt: read-only — pure arithmetic over published constants, reads no organisation data and mutates nothing. The kernel capability.invoke_* audit covers access.
/**
 * preview_action_cost handler (spec §3.4 + §4.1).
 *
 * The run → action calculator. Pure arithmetic over published constants: no DB
 * read, no organisation data, no ClickHouse. A quote a buyer cannot reproduce
 * on paper is not a published price, so every input to the answer is echoed
 * back in `assumptions`.
 */

import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  billingActionEstimate,
  RUN_CLASSES,
} from "@oxagen/oxagen/contracts/billing.action_estimate";
import type { PlanTier } from "@oxagen/oxagen/types";
import { publishedAllowanceForTier, resolveActionBand } from "@oxagen/billing";
import { logger } from "./logger";

type RunClass = (typeof RUN_CLASSES)[number];

/**
 * Governed actions per run, by run class — spec §3.4.
 *
 * The spec publishes RANGES ("Q&A / lookup: 2–5", "Standard task: 10–20",
 * "Multi-step / coding: 30–80", "Long-running workflow: 100+"). A calculator
 * needs one number per class, so each range is taken at its midpoint. The
 * midpoint is not a choice made here: spec §4.5's worked example prices the
 * reference customer's standard-task runs at 15, which is exactly the midpoint
 * of 10–20, so the whole table is read the same way as the one entry the spec
 * pins.
 *
 * `long_running` is open-ended ("100+") and so has no midpoint. It takes the
 * published floor, 100 — the only figure in the range the spec actually states,
 * and the one that cannot overstate a customer's volume.
 *
 * Spec §3.4 says these are "to be re-derived from production data each quarter
 * rather than asserted". When that derivation lands, this table is what it
 * replaces.
 */
const ACTIONS_PER_RUN_BY_CLASS: Readonly<Record<RunClass, number>> = {
  qa_lookup: 3.5,
  standard_task: 15,
  multi_step: 55,
  long_running: 100,
};

/** Tier a quote prices against when the caller names none. */
const DEFAULT_QUOTE_TIER: PlanTier = "scale";

export const billingActionEstimateHandler: CapabilityHandler<
  typeof billingActionEstimate
> = async (input) => {
  const runClass = input.runClass;
  const tier = input.tier ?? DEFAULT_QUOTE_TIER;

  // A measured ratio beats a published typical one, and the output says which
  // of the two produced the number.
  const callerSupplied = input.actionsPerRun !== undefined;
  const actionsPerRun = callerSupplied
    ? (input.actionsPerRun as number)
    : ACTIONS_PER_RUN_BY_CLASS[runClass];

  const actionsPerYear = Math.floor(input.runsPerYear * actionsPerRun);
  const includedActionsAnnual = publishedAllowanceForTier(tier);

  // Null means "negotiated per contract" (spec §7.3), and a quote must not
  // invent the figure that was negotiated. Treating it as zero prices the whole
  // projected volume as overage, which is the upper bound of what the customer
  // could owe — an enterprise quote that comes in UNDER the negotiated floor is
  // a pleasant correction at signature; one that came in over it is a broken
  // promise. `ENTERPRISE_FALLBACK_ALLOWANCE` is deliberately not used: it is a
  // charging-path safety net for a mis-provisioned plan row, not a published
  // entitlement anyone agreed to.
  const overageActions = Math.max(
    0,
    actionsPerYear - (includedActionsAnnual ?? 0),
  );

  // §4.1 selects the band on the whole ANNUAL volume, not on the overage slice.
  const band = resolveActionBand(actionsPerYear);
  const overageUsd = (overageActions * band.usdPer1000) / 1000;

  logger.debug(
    {
      runsPerYear: input.runsPerYear,
      runClass,
      actionsPerRun,
      actionsPerRunSource: callerSupplied ? "caller_supplied" : "run_class",
      tier,
      actionsPerYear,
      overageActions,
      band: band.id,
      overageUsd,
    },
    "preview_action_cost: quoted governed-action overage",
  );

  return {
    assumptions: {
      runsPerYear: input.runsPerYear,
      actionsPerRun,
      actionsPerRunSource: callerSupplied
        ? ("caller_supplied" as const)
        : ("run_class" as const),
      runClass,
      tier,
    },
    actionsPerYear,
    includedActionsAnnual,
    overageActions,
    band: { id: band.id, usdPer1000: band.usdPer1000 },
    overageUsd,
    excludes:
      "This estimate covers governed-action overage only. It excludes the subscription platform fee for your tier, which is negotiated on enterprise, and it excludes model tokens, which under BYOK your own provider key pays for directly and Oxagen charges at zero.",
  };
};
