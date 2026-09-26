// What Fleet computes from the rows it read (fleet.md, "Functionality"): the
// state word a row carries, which rows a filter chip lists, the tile figures
// over the rows listed (Live runs is the workspace's, counted by `list_runs`,
// not a figure over the rows), and how a row names its pull requests. Pure,
// so the tiles and the table read one computation and a header can never
// disagree with the rows beneath it.
//
// Search, facets, sort and paging are the read's (#3837): values on the URL
// that `list_runs` applies across the workspace (`list-query.ts`). Nothing
// here filters, orders or pages the rows one read returned.
//
// Nothing here invents a figure. A row whose cost was not recorded is left out
// of the sum and counted, so the tile can say how many it left out. Tokens
// work the same way (`tokens.ts`): a row with no count is left out of the
// Tokens shown sum and counted, never added as a zero.
import type { ApprovalItem } from "@/data/contracts/approvals";
import { type Cost, type Money, sumMoney } from "@/data/contracts/money";
import type { RunPullRequest, RunRow } from "@/data/contracts/runs";

/**
 * The state a row reads as. Each word beyond the run's lifecycle status comes
 * from a record, never a guess (ADR-193):
 *
 * - `paused`: a live run whose last applied command paused it
 *   (`ingressPaused`). It wins over parked, as on the Run page: a paused run
 *   takes no step whatever its calls are waiting on.
 * - `parked`: a live run with a call parked on a pending approval. The
 *   approval record names the run (`list_approvals` carries its `run_id`).
 * - `compacted`: a sealed run whose recording frame compaction moved to its
 *   archive segment (`compacted`).
 */
export type RowState =
  | "live"
  | "parked"
  | "paused"
  | "sealed"
  | "compacted"
  | "halted";

/**
 * The state a row's badge names.
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function rowState(run: RunRow, parked: ReadonlySet<string>): RowState {
  if (run.status === "live") {
    if (run.ingressPaused === true) return "paused";
    return parked.has(run.id) ? "parked" : "live";
  }
  if (run.status === "sealed" && run.compacted === true) return "compacted";
  return run.status;
}

/** The run ids a pending approval names, for `rowState`. */
export function parkedRunIds(items: readonly ApprovalItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) if (item.runId !== null) ids.add(item.runId);
  return ids;
}

/** The Runs panel's filter chips, in the order the header draws them. */
export const RUN_CHIPS = ["all", "live", "parked", "sealed"] as const;
export type RunChip = (typeof RUN_CHIPS)[number];

/**
 * Which states a chip lists: `live` is every open run (live, parked and
 * paused), `parked` is the open runs waiting on a person (parked and paused),
 * and `sealed` is sealed and compacted. `all` lists every row, halted ones
 * included.
 */
const CHIP_STATES: Record<Exclude<RunChip, "all">, readonly RowState[]> = {
  live: ["live", "parked", "paused"],
  parked: ["parked", "paused"],
  sealed: ["sealed", "compacted"],
};

export function chipRows<T extends { state: RowState }>(
  rows: readonly T[],
  chip: RunChip,
): T[] {
  if (chip === "all") return [...rows];
  const states = CHIP_STATES[chip];
  return rows.filter((row) => states.includes(row.state));
}

/** A run and the state it reads as, the unit every figure below counts. */
export type ListedRun = { run: RunRow; state: RowState };

export function listRuns(
  runs: readonly RunRow[],
  parked: ReadonlySet<string>,
): ListedRun[] {
  return runs.map((run) => ({ run, state: rowState(run, parked) }));
}

type ShownCost = { value: Cost; reported: boolean; estimate: boolean };

/**
 * The cost a row shows: the rollup's figure when there is one, else what the
 * agent reported, as the Run page shows it until a rollup lands. A running
 * rollup and a report are both estimates.
 */
export function shownCost(run: RunRow): ShownCost | null {
  if (run.cost !== null)
    return {
      value: run.cost,
      reported: false,
      estimate: run.costIsEstimate === true,
    };
  const reported = run.reportedCost ?? null;
  return reported === null
    ? null
    : { value: reported, reported: true, estimate: true };
}

/**
 * Whether a sealed wrapped run's rollup found no model call and its agent
 * reported no usage either (#3304). Its harness's model calls passed through
 * neither the gateway nor the local proxy, so no total can carry its cost. A
 * run with no rollup row yet is not one of these: it may simply not have been
 * rolled up, so it reads as no cost recorded. Neither is an open run: the
 * rollup writes a row on a run's first batch, before its first model call
 * can land, so every new run briefly holds no usage.
 */
export function reportedNoUsage(run: RunRow): boolean {
  if (run.source !== "tacho" || run.status === "live") return false;
  if (shownCost(run) !== null) return false;
  const rolled = run.tokens ?? null;
  if (rolled === null) return false;
  const counted =
    rolled.inputUncached +
    rolled.cacheRead +
    rolled.cacheWrite5m +
    rolled.cacheWrite1h +
    rolled.output +
    rolled.reasoning;
  const reported = run.reportedTokens ?? null;
  const reportedCount =
    reported === null
      ? 0
      : reported.input +
        reported.output +
        reported.cacheRead +
        reported.cacheWrite;
  return counted === 0 && reportedCount === 0;
}

/**
 * Spend shown: the sum of the cost the rows listed show, the bases read off
 * those rows in the order they first appear, and how many rows had no cost
 * to add. `total` is null when no row carried a cost, or when the costs
 * carry more than one currency, since no one was charged a sum across two.
 */
export type SpendShown = {
  total: Money | null;
  bases: string[];
  /** Rows whose cost was recorded with no basis. */
  unbased: number;
  /**
   * Rows with no cost recorded, left out of `total`, apart from the rows
   * counted in {@link SpendShown.noUsage}.
   */
  unpriced: number;
  /**
   * Rows that reported no usage at all, by the harness that ran them, most
   * first ({@link reportedNoUsage}). Also left out of `total`.
   */
  noUsage: { harness: string; runs: number }[];
  /**
   * Priced rows whose cost is a running estimate or the agent's report,
   * counted in `total`.
   */
  estimated: number;
  /** True when the priced rows carry more than one currency. */
  mixedCurrency: boolean;
};

export function spendShown(rows: readonly ListedRun[]): SpendShown {
  const shown = rows.flatMap(({ run }) => {
    const cost = shownCost(run);
    return cost === null ? [] : [cost];
  });
  const costs = shown.map((cost) => cost.value);
  const bases: string[] = [];
  let unbased = 0;
  for (const cost of costs) {
    if (cost.basis === null) unbased += 1;
    else if (!bases.includes(cost.basis)) bases.push(cost.basis);
  }
  const total = sumMoney(costs);
  const byHarness = new Map<string, number>();
  for (const { run } of rows) {
    if (!reportedNoUsage(run)) continue;
    const harness = run.harness?.name ?? "unknown";
    byHarness.set(harness, (byHarness.get(harness) ?? 0) + 1);
  }
  const noUsage = [...byHarness.entries()]
    .map(([harness, runs]) => ({ harness, runs }))
    .sort(
      (a, b) =>
        b.runs - a.runs ||
        (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0),
    );
  const unreported = noUsage.reduce((sum, row) => sum + row.runs, 0);
  return {
    total,
    bases,
    unbased,
    unpriced: rows.length - costs.length - unreported,
    noUsage,
    estimated: shown.filter((cost) => cost.estimate).length,
    mixedCurrency: costs.length > 0 && total === null,
  };
}

/**
 * The oldest pending approval and its window, for the waiting tile's clock:
 * how long it has waited, out of how long it may wait before it expires.
 */
export function oldestApproval(
  items: readonly ApprovalItem[],
): { createdAt: number; windowSeconds: number } | null {
  let oldest: ApprovalItem | null = null;
  for (const item of items)
    if (
      oldest === null ||
      Date.parse(item.createdAt) < Date.parse(oldest.createdAt)
    )
      oldest = item;
  if (oldest === null) return null;
  const createdAt = Date.parse(oldest.createdAt);
  return {
    createdAt,
    windowSeconds: Math.max(
      0,
      (Date.parse(oldest.expiresAt) - createdAt) / 1000,
    ),
  };
}

/**
 * An approval's window in whole minutes and the seconds left over, for the
 * waiting tile's "of 10m" (fleet.md). A window is a policy setting, not a
 * clock, so it reads as a duration and never as m:ss.
 */
export function windowParts(windowSeconds: number): {
  minutes: number;
  seconds: number;
} {
  const total = Math.max(0, Math.round(windowSeconds));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

// ── Pull requests and lines ───────────────────────────────────────────────

/**
 * How many pull requests a row can name: the links its frames recorded, else
 * the `pr_open` calls counted, else null when neither was read (a ledger run).
 * Exported for its tests.
 *
 * @internal
 */
export function pullRequestCount(run: RunRow): number | null {
  const links = run.pullRequests?.length ?? null;
  const opened = run.pullRequestsOpened ?? null;
  if (links === null && opened === null) return null;
  return Math.max(links ?? 0, opened ?? 0);
}

/** The forge a pull request URL names, by host. Self-hosted forges read null. */
export function forgeOf(url: string): "github" | "gitlab" | null {
  if (!URL.canParse(url)) return null;
  const host = new URL(url).hostname;
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  return null;
}

/**
 * A pull request as a person names it on its forge: `owner/repo#12` on
 * GitHub, `group/project!12` for a GitLab merge request. The repository is
 * left off when the frame recorded none, and the number when it recorded none.
 */
export function pullRequestLabel(pull: RunPullRequest): string | null {
  if (pull.number === null) return pull.repository;
  const mark = forgeOf(pull.url) === "gitlab" ? "!" : "#";
  return `${pull.repository ?? ""}${mark}${String(pull.number)}`;
}
