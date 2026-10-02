/**
 * spend-per-merged-pr.ts: what each agent spent per pull request that landed
 * (spend spec, detector 8, its first lever; F26).
 *
 * The figure covers bounded runs only. Nothing in the record marks a bounded
 * task until work orders arrive (F13), so a bounded run here is a run that
 * opened a pull request: it has a `cost.run_pr_outcomes` row whose `pr_key`
 * is not `none`. Per agent and period, the figure is the spend on those runs
 * divided by the distinct pull requests they opened that merged and were not
 * reverted within `REVERT_WINDOW_DAYS` of the merge. A revert counts the way
 * detector 8 counts it (`findings/spend-with-no-outcome.ts`): on or after the
 * merge, and at most the window after it. A merge or revert with no time, and
 * a revert dated before its merge, leave the merge standing.
 *
 * Every bounded run adds its spend, whatever its pull requests became: one
 * still open, or not read yet, adds to the spend and not to the merged count.
 * An agent with no merged pull request has no figure, never a zero. The
 * handler reads the rows (packages/handlers `spend.per_merged_pr.ts`); this
 * module is the pure fold.
 */
import { type CostBasis, foldBasis } from "./cost-rollup";
import { REVERT_WINDOW_DAYS } from "./findings/spend-with-no-outcome";
import { NO_PR_KEY, type OutcomeRow } from "./run-pr-outcomes";

export { REVERT_WINDOW_DAYS };

/** At most this many runs are listed under one agent, costliest first. */
export const PER_MERGED_PR_RUNS_MAX = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One run in the period, as `cost.run_totals` priced it. */
export interface PerMergedPrRun {
  runId: string;
  /** The agent's key (`org_ns.ws_ns.slug`); a run with none has no agent row. */
  agentKey: string | null;
  startedAt: Date;
  /** Null when the rollup priced no model call of the run. */
  costMicros: bigint | null;
  currency: string;
  costBasis: CostBasis | null;
}

/** The columns of one `cost.run_pr_outcomes` row this figure reads. */
export type PerMergedPrOutcome = Pick<
  OutcomeRow,
  | "runId"
  | "prKey"
  | "url"
  | "prState"
  | "merged"
  | "mergedAt"
  | "reverted"
  | "revertedAt"
>;

/**
 * What one pull request became, as this figure counts it. Only `merged`
 * counts. `reverted` merged and was reverted within the window, and
 * `unread` has no state read yet.
 */
export type PerMergedPrState =
  | "merged"
  | "reverted"
  | "closed"
  | "open"
  | "unread";

/** Why an agent has no figure. */
export type PerMergedPrAbsence =
  /** None of the agent's bounded runs opened a pull request that landed. */
  | "no_merged_pr"
  /** The agent's bounded runs are priced in more than one currency. */
  | "mixed_currency"
  /** The rollup priced none of the agent's bounded runs. */
  | "not_priced";

export interface PerMergedPrCost {
  micros: bigint;
  currency: string;
  basis: CostBasis;
}

/** One bounded run behind an agent's figure. */
export interface PerMergedPrRunFigure {
  runId: string;
  startedAt: Date;
  cost: PerMergedPrCost | null;
  pullRequests: { prKey: string; url: string | null; state: PerMergedPrState }[];
}

/** One agent's figure for the period. */
export interface AgentPerMergedPr {
  agentKey: string;
  /** Runs that opened at least one pull request. */
  boundedRuns: number;
  /** Bounded runs the rollup priced nothing for; their spend is not in `spend`. */
  unpricedRuns: number;
  /** The spend on the priced bounded runs; null when there is no single figure. */
  spend: PerMergedPrCost | null;
  /** Distinct pull requests those runs opened that merged and stayed. */
  mergedPrs: number;
  /** `spend` over `mergedPrs`, rounded to the nearest micro; null when absent. */
  perMergedPr: PerMergedPrCost | null;
  /** Why `perMergedPr` is null; null when it is not. */
  absence: PerMergedPrAbsence | null;
  /** The costliest bounded runs, at most `PER_MERGED_PR_RUNS_MAX`. */
  runs: PerMergedPrRunFigure[];
}

/**
 * Whether a merged pull request was reverted within the window: on or after
 * its merge, and `REVERT_WINDOW_DAYS` or fewer after it. Detector 8 holds the
 * same rule.
 */
export function revertedWithinWindow(
  row: Pick<OutcomeRow, "reverted" | "mergedAt" | "revertedAt">,
): boolean {
  if (!row.reverted || row.mergedAt === null || row.revertedAt === null)
    return false;
  const delta = row.revertedAt.getTime() - row.mergedAt.getTime();
  return delta >= 0 && delta <= REVERT_WINDOW_DAYS * DAY_MS;
}

/** What one pull request became, for this figure. */
export function perMergedPrState(row: PerMergedPrOutcome): PerMergedPrState {
  if (row.merged || row.prState === "merged")
    return revertedWithinWindow(row) ? "reverted" : "merged";
  if (row.prState === "closed") return "closed";
  if (row.prState === "open") return "open";
  return "unread";
}

/** `micros` over `count`, rounded half up. `count` is positive. */
function dividedRounded(micros: bigint, count: number): bigint {
  const n = BigInt(count);
  const half = micros >= 0n ? n : -n;
  return (micros * 2n + half) / (2n * n);
}

interface Accumulator {
  agentKey: string;
  runs: PerMergedPrRunFigure[];
  unpricedRuns: number;
  micros: bigint;
  currencies: Set<string>;
  basis: CostBasis | null;
  merged: Set<string>;
}

const byCostDesc = (a: PerMergedPrRunFigure, b: PerMergedPrRunFigure): number => {
  const am = a.cost?.micros ?? -1n;
  const bm = b.cost?.micros ?? -1n;
  if (am !== bm) return am > bm ? -1 : 1;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
};

/**
 * Each agent's spend per merged pull request, from the period's runs and
 * their outcome rows. A run with no agent, and a run with no pull request row,
 * is left out. A pull request two runs of one agent opened counts once for
 * that agent. Agents come back in key order.
 */
export function spendPerMergedPr(
  runs: readonly PerMergedPrRun[],
  outcomes: readonly PerMergedPrOutcome[],
): AgentPerMergedPr[] {
  const prsOf = new Map<string, PerMergedPrOutcome[]>();
  for (const row of outcomes) {
    if (row.prKey === NO_PR_KEY) continue;
    const held = prsOf.get(row.runId);
    if (held) held.push(row);
    else prsOf.set(row.runId, [row]);
  }

  const agents = new Map<string, Accumulator>();
  const seen = new Set<string>();
  for (const run of runs) {
    if (run.agentKey === null || seen.has(run.runId)) continue;
    const prs = prsOf.get(run.runId);
    if (prs === undefined) continue;
    seen.add(run.runId);
    const acc = agents.get(run.agentKey) ?? {
      agentKey: run.agentKey,
      runs: [],
      unpricedRuns: 0,
      micros: 0n,
      currencies: new Set<string>(),
      basis: null,
      merged: new Set<string>(),
    };
    agents.set(run.agentKey, acc);

    const cost: PerMergedPrCost | null =
      run.costMicros !== null && run.costBasis !== null
        ? { micros: run.costMicros, currency: run.currency, basis: run.costBasis }
        : null;
    if (cost === null) {
      acc.unpricedRuns += 1;
    } else {
      acc.micros += cost.micros;
      acc.currencies.add(cost.currency);
      acc.basis = foldBasis(acc.basis, cost.basis);
    }
    const pullRequests = prs
      .map((row) => ({
        prKey: row.prKey,
        url: row.url,
        state: perMergedPrState(row),
      }))
      .sort((a, b) => (a.prKey < b.prKey ? -1 : a.prKey > b.prKey ? 1 : 0));
    for (const pr of pullRequests)
      if (pr.state === "merged") acc.merged.add(pr.prKey);
    acc.runs.push({
      runId: run.runId,
      startedAt: run.startedAt,
      cost,
      pullRequests,
    });
  }

  return [...agents.values()]
    .sort((a, b) =>
      a.agentKey < b.agentKey ? -1 : a.agentKey > b.agentKey ? 1 : 0,
    )
    .map((acc): AgentPerMergedPr => {
      const currency =
        acc.currencies.size === 1 ? [...acc.currencies][0]! : null;
      const spend =
        currency === null || acc.basis === null
          ? null
          : { micros: acc.micros, currency, basis: acc.basis };
      const mergedPrs = acc.merged.size;
      const absence: PerMergedPrAbsence | null =
        mergedPrs === 0
          ? "no_merged_pr"
          : acc.currencies.size > 1
            ? "mixed_currency"
            : spend === null
              ? "not_priced"
              : null;
      return {
        agentKey: acc.agentKey,
        boundedRuns: acc.runs.length,
        unpricedRuns: acc.unpricedRuns,
        spend,
        mergedPrs,
        perMergedPr:
          absence === null && spend !== null
            ? { ...spend, micros: dividedRounded(spend.micros, mergedPrs) }
            : null,
        absence,
        runs: [...acc.runs].sort(byCostDesc).slice(0, PER_MERGED_PR_RUNS_MAX),
      };
    });
}
