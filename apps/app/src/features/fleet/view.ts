// What Fleet computes from the rows it read (fleet.md, "Functionality"): the
// state word a row carries, which rows a filter chip lists, the four tile
// figures over the rows listed, and the list controls (search, facets, sort,
// rows per page) over the same rows. Pure, so the tiles and the table read one
// computation and a header can never disagree with the rows beneath it.
//
// Nothing here invents a figure. A row whose cost was not recorded is left out
// of the sum and counted, so the tile can say how many it left out. Tokens are
// not on `list_runs` yet, so there is no token sum to take and the tile says
// so rather than printing a zero.
import type { ApprovalItem } from "@/data/contracts/approvals";
import { compareMicros, type Money, sumMoney } from "@/data/contracts/money";
import type { RunRow } from "@/data/contracts/runs";

/**
 * The state a row reads as. `parked` is a live run with a call parked on a
 * pending approval: the approval record names the run (`list_approvals`
 * carries its `run_id`), so the word comes from two records and not from a
 * guess. `paused` and `compacted` are in the design's vocabulary and not in
 * the run record's, so no row reads as either.
 */
export type RowState = "live" | "parked" | "sealed" | "halted";

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

/** Live runs among the rows listed; a parked run is waiting, so it is not counted live. */
export function liveCount(rows: readonly ListedRun[]): number {
  return rows.filter((row) => row.state === "live").length;
}

/**
 * Spend shown: the sum of the cost the rows listed recorded, the bases read
 * off those rows in the order they first appear, and how many rows had no
 * cost to add. `total` is null when no row carried a cost, or when the costs
 * carry more than one currency, since no one was charged a sum across two.
 */
export type SpendShown = {
  total: Money | null;
  bases: string[];
  /** Rows whose cost was recorded with no basis. */
  unbased: number;
  /** Rows with no cost recorded, left out of `total`. */
  unpriced: number;
  /** True when the priced rows carry more than one currency. */
  mixedCurrency: boolean;
};

export function spendShown(rows: readonly ListedRun[]): SpendShown {
  const costs = rows.flatMap(({ run }) =>
    run.cost === null ? [] : [run.cost],
  );
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

// ── The list controls ─────────────────────────────────────────────────────

/** Rows per page; 0 is All. */
export const ROWS_PER_PAGE = [5, 10, 25, 50, 0] as const;
export type RowsPerPage = (typeof ROWS_PER_PAGE)[number];

/** The Rows select's value as a page size, or null for a value it never offers. */
export function rowsPerPageOf(value: string): RowsPerPage | null {
  return ROWS_PER_PAGE.find((per) => String(per) === value) ?? null;
}

/** The columns a header click sorts on. */
export const SORT_KEYS = [
  "run",
  "agent",
  "operator",
  "status",
  "tier",
  "replay",
  "cost",
  "frames",
  "started",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type Sort = { key: SortKey; dir: 1 | -1 } | null;

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
  perPage: RowsPerPage;
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

function micros(row: ListedRun): string | null {
  return row.run.cost === null ? null : row.run.cost.micros;
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
      const x = micros(a);
      const y = micros(b);
      // A row with no cost sorts after every priced row, in either direction
      // of the figures among themselves.
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return compareMicros(x, y);
    }
    case "frames":
      return a.run.frames - b.run.frames;
    case "started":
      return Date.parse(a.run.startedAt) - Date.parse(b.run.startedAt);
    default:
      return compareText(wa[key], wb[key]);
  }
}

/** Whether a missing value keeps its place at the end whatever the direction. */
function nullLast(row: ListedRun, key: SortKey): boolean {
  return key === "cost" && row.run.cost === null;
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

/**
 * The page buttons a pager draws: every page up to seven, otherwise the
 * first, the last, the current page and its neighbours, with a gap marker
 * where pages are skipped (the design's `ltPager`).
 */
export function pagerSlots(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const slots: (number | "gap")[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(pages - 1, page + 1);
  if (lo > 2) slots.push("gap");
  for (let p = lo; p <= hi; p += 1) slots.push(p);
  if (hi < pages - 1) slots.push("gap");
  slots.push(pages);
  return slots;
}
