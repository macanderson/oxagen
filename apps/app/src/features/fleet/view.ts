// What Fleet computes from the rows it read (fleet.md, "Functionality"): the
// state word a row carries, which rows a filter chip lists, the tile figures
// over the rows listed (Live runs is the workspace's, counted by `list_runs`,
// not a figure over the rows), how a row names its pull requests, and the
// list controls (search, facets, sort) over the same rows. The page size is
// the read's own limit, so no control here pages the rows. Pure, so the tiles and the table read one
// computation and a header can never disagree with the rows beneath it.
//
// Nothing here invents a figure. A row whose cost was not recorded is left out
// of the sum and counted, so the tile can say how many it left out. Tokens are
// not on `list_runs` yet, so there is no token sum to take and the tile says
// so rather than printing a zero.
import type { ApprovalItem } from "@/data/contracts/approvals";
import {
  compareMicros,
  type Cost,
  type Money,
  sumMoney,
} from "@/data/contracts/money";
import type { RunPullRequest, RunRow } from "@/data/contracts/runs";

/**
 * The state a row reads as. `parked` is a live run with a call parked on a
 * pending approval: the approval record names the run (`list_approvals`
 * carries its `run_id`), so the word comes from two records and not from a
 * guess. `paused` and `compacted` are in the design's vocabulary and not in
 * the run record's, so no row reads as either.
 */
export type RowState = "live" | "parked" | "sealed" | "halted";

/**
 * The state a row's badge names.
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function rowState(run: RunRow, parked: ReadonlySet<string>): RowState {
  if (run.status === "live") return parked.has(run.id) ? "parked" : "live";
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
 * Which states a chip lists: `live` is live and parked, `parked` is parked
 * (and paused, which the record does not carry), `sealed` is sealed (and
 * compacted, likewise). `all` lists every row, halted ones included.
 */
const CHIP_STATES: Record<Exclude<RunChip, "all">, readonly RowState[]> = {
  live: ["live", "parked"],
  parked: ["parked"],
  sealed: ["sealed"],
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
  /** Rows with no cost recorded, left out of `total`. */
  unpriced: number;
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
  return {
    total,
    bases,
    unbased,
    unpriced: rows.length - costs.length,
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

// ── The list controls ─────────────────────────────────────────────────────

/** The columns a header click sorts on. */
export type SortKey =
  | "run"
  | "agent"
  | "operator"
  | "status"
  | "pullRequests"
  | "diff"
  | "tier"
  | "replay"
  | "cost"
  | "frames"
  | "started";

type Sort = { key: SortKey; dir: 1 | -1 } | null;

/** The three facets the list offers, each over the words its column shows. */
export type Facets = {
  tier: string | null;
  replay: string | null;
  status: string | null;
};

export type ListQuery = {
  search: string;
  facets: Facets;
  sort: Sort;
  /** Rows per page; 0 lists every row. */
  perPage: number;
  /** 1-based. */
  page: number;
};

/**
 * The words one row shows in each searchable, facetable and sortable column.
 * The caller supplies them, already translated, so the list filters on what a
 * person reads and not on a wire code they never see.
 */
export type RowWords = {
  run: string;
  agent: string;
  operator: string;
  status: string;
  tier: string;
  replay: string;
  /** Every word on the row, for the search box. */
  text: string;
};

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function compare(
  a: ListedRun,
  b: ListedRun,
  wa: RowWords,
  wb: RowWords,
  key: SortKey,
): number {
  switch (key) {
    case "cost": {
      const x = shownCost(a.run)?.value ?? null;
      const y = shownCost(b.run)?.value ?? null;
      // A row with no cost sorts after every priced row, in either direction
      // of the figures among themselves.
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return compareMicros(x, y);
    }
    case "frames":
      return a.run.frames - b.run.frames;
    case "pullRequests":
      return (pullRequestCount(a.run) ?? 0) - (pullRequestCount(b.run) ?? 0);
    case "diff": {
      const x = a.run.diff ?? null;
      const y = b.run.diff ?? null;
      return (
        (x === null ? 0 : x.added + x.removed) -
        (y === null ? 0 : y.added + y.removed)
      );
    }
    case "started":
      return Date.parse(a.run.startedAt) - Date.parse(b.run.startedAt);
    default:
      return compareText(wa[key], wb[key]);
  }
}

/** Whether a missing value keeps its place at the end whatever the direction. */
function nullLast(row: ListedRun, key: SortKey): boolean {
  if (key === "cost") return shownCost(row.run) === null;
  if (key === "diff") return (row.run.diff ?? null) === null;
  if (key === "pullRequests") return pullRequestCount(row.run) === null;
  return false;
}

/** The distinct words a facet can pick from, sorted, over the rows given. */
export function facetValues(
  words: readonly RowWords[],
  facet: keyof Facets,
): string[] {
  return [...new Set(words.map((w) => w[facet]))].sort(compareText);
}

export type ListedPage<T> = {
  rows: T[];
  /** Rows the search and facets let through, before paging. */
  total: number;
  page: number;
  pages: number;
  /** 1-based index of the first row shown; 0 when none is. */
  from: number;
  to: number;
};

/**
 * Search, facets, sort and page over the rows a chip listed. `words` is
 * parallel to `rows`. A stable sort: rows that compare equal keep the order
 * the read returned, which is newest first.
 */
export function applyList(
  rows: readonly ListedRun[],
  words: readonly RowWords[],
  q: ListQuery,
): ListedPage<number> {
  const needle = q.search.trim().toLowerCase();
  let idx = rows
    .map((_, i) => i)
    .filter((i) => {
      const w = words[i];
      if (w === undefined) return false;
      if (needle !== "" && !w.text.toLowerCase().includes(needle)) return false;
      for (const facet of ["tier", "replay", "status"] as const) {
        const want = q.facets[facet];
        if (want !== null && w[facet] !== want) return false;
      }
      return true;
    });
  const sort = q.sort;
  if (sort !== null) {
    idx = [...idx].sort((i, j) => {
      const a = rows[i];
      const b = rows[j];
      const wa = words[i];
      const wb = words[j];
      if (!a || !b || !wa || !wb) return 0;
      const la = nullLast(a, sort.key);
      const lb = nullLast(b, sort.key);
      if (la !== lb) return la ? 1 : -1;
      return compare(a, b, wa, wb, sort.key) * sort.dir || i - j;
    });
  }
  const total = idx.length;
  const per = q.perPage === 0 ? Math.max(total, 1) : q.perPage;
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(Math.max(1, q.page), pages);
  const start = (page - 1) * per;
  const shown = idx.slice(start, start + per);
  return {
    rows: shown,
    total,
    page,
    pages,
    from: total === 0 ? 0 : start + 1,
    to: start + shown.length,
  };
}
