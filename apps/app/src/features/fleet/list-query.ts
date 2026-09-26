// Fleet's runs list query, as the URL carries it (#3837). The search, the
// Status, Tier and Replay facets, the order and the page are values on the
// route, and the server read applies them across the workspace. A person can
// link a filtered, sorted page, and the pager can say how many runs match.
//
// The facet options are the closed vocabularies the read filters on, not the
// words on the rows one page returned: a facet can pick a tier no run on this
// page carries, and that is what finds the runs on other pages.
//
// `parked` is not a Status value here. A run is parked when a pending approval
// names it, which the approvals read knows and `list_runs` does not, so the
// chips find parked runs among the rows of a page and the Status facet offers
// the lifecycle words the record holds: live, sealed and halted.
//
// Pure: the page parses the URL with it on the server, and the list controls
// build the next URL with it in the browser.
import {
  EnforcementTier,
  type PullRequestFilter,
  RunReplayFilter,
  RunSortKey,
  RunStatus,
} from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import type { FleetColumn } from "./prefs";

/** The Status facet's options, in the order the contract lists them. */
export const STATUS_FACET: readonly RunStatus[] = RunStatus.options;
/** The Tier facet's options: the enforcement ladder. */
export const TIER_FACET: readonly EnforcementTier[] = EnforcementTier.options;
/** The Replay facet's options: the grades, weakest first, then none recorded. */
export const REPLAY_FACET: readonly RunReplayFilter[] = RunReplayFilter.options;

/** The most rows the read skips (`RUN_LIST_TOTAL_BOUND` on the contract). */
export const OFFSET_BOUND = 10_000;

/** What the Runs panel lists, beside the cursor and the pull-request filter. */
export type FleetListQuery = {
  /** The search text; empty is no search. */
  q: string;
  status: RunStatus[];
  tier: EnforcementTier[];
  replay: RunReplayFilter[];
  sort: RunSortKey;
  dir: "asc" | "desc";
  /** 1-based. */
  page: number;
};

export const DEFAULT_LIST_QUERY: FleetListQuery = {
  q: "",
  status: [],
  tier: [],
  replay: [],
  sort: "started",
  dir: "desc",
  page: 1,
};

/** Search params as a route receives them. */
export type ListParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The words of a comma list that a vocabulary names, once each, in its order. */
function wordsOf<T extends string>(
  raw: string | undefined,
  vocabulary: readonly T[],
): T[] {
  if (raw === undefined) return [];
  const asked = new Set(raw.split(",").map((word) => word.trim()));
  return vocabulary.filter((word) => asked.has(word));
}

/** The longest search the read accepts. */
const QUERY_MAX = 200;

/**
 * The list query a URL asks for. Anything this build does not know (a word
 * outside a vocabulary, a page that is not a positive whole number, a sort on
 * a column the read cannot order) is dropped, and the default stands.
 */
export function parseListQuery(params: ListParams): FleetListQuery {
  const sort = RunSortKey.safeParse(first(params.sort));
  const dir = first(params.dir);
  const page = Number(first(params.page));
  return {
    q: (first(params.q) ?? "").trim().slice(0, QUERY_MAX),
    status: wordsOf(first(params.status), STATUS_FACET),
    tier: wordsOf(first(params.tier), TIER_FACET),
    replay: wordsOf(first(params.replay), REPLAY_FACET),
    sort: sort.success ? sort.data : DEFAULT_LIST_QUERY.sort,
    dir: dir === "asc" || dir === "desc" ? dir : DEFAULT_LIST_QUERY.dir,
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/** Whether the list is in the newest-first order a cursor pages. */
export function isNewestFirst(list: FleetListQuery): boolean {
  return list.sort === "started" && list.dir === "desc";
}

/** Whether nothing narrows the list: no search and no facet. */
export function isUnfiltered(list: FleetListQuery): boolean {
  return (
    list.q === "" &&
    list.status.length === 0 &&
    list.tier.length === 0 &&
    list.replay.length === 0
  );
}

/**
 * The list the read can serve under a pull-request filter. That filter is
 * read from each run's frames a page at a time, so it pages newest first by
 * cursor: the order and the page fall back to their defaults.
 */
export function effectiveListQuery(
  list: FleetListQuery,
  pullRequests: PullRequestFilter,
): FleetListQuery {
  return pullRequests === "any"
    ? list
    : { ...list, sort: "started", dir: "desc", page: 1 };
}

/** The last page a read can reach at this page size: the offset is bounded. */
export function lastReachablePage(pageSize: number): number {
  return Math.floor(OFFSET_BOUND / pageSize) + 1;
}

/**
 * The `runs.list` query for a list, a cursor, a pull-request filter and a
 * page size. A cursor is sent only on page 1 of the newest-first order, since
 * the read refuses one with an offset or another order.
 */
export function toRunsListQuery(
  list: FleetListQuery,
  at: {
    cursor: string | null;
    pullRequests: PullRequestFilter;
    pageSize: number;
  },
): Parameters<DataSource["runs"]["list"]>[1] {
  const served = effectiveListQuery(list, at.pullRequests);
  const page = Math.min(served.page, lastReachablePage(at.pageSize));
  const cursor = page === 1 && isNewestFirst(served) ? at.cursor : null;
  return {
    cursor,
    limit: at.pageSize,
    pullRequests: at.pullRequests,
    ...(served.status.length === 0 ? {} : { status: served.status }),
    ...(served.tier.length === 0 ? {} : { tier: served.tier }),
    ...(served.replay.length === 0 ? {} : { replayGrade: served.replay }),
    ...(served.q === "" ? {} : { query: served.q }),
    ...(isNewestFirst(served)
      ? {}
      : { sort: { key: served.sort, dir: served.dir } }),
    ...(page > 1 ? { offset: (page - 1) * at.pageSize } : {}),
  };
}

/** The `routes.fleet` query for a list and a pull-request filter. */
export function listQueryToRoute(
  list: FleetListQuery,
  pullRequests: PullRequestFilter,
): {
  prs: PullRequestFilter;
  q: string;
  status: string;
  tier: string;
  replay: string;
  sort: string;
  dir: "asc" | "desc";
  page: number;
} {
  return {
    prs: pullRequests,
    q: list.q,
    status: list.status.join(","),
    tier: list.tier.join(","),
    replay: list.replay.join(","),
    sort: list.sort,
    dir: list.dir,
    page: list.page,
  };
}

/**
 * The list after a change to what it lists: a new search, facet or order
 * starts again at page 1, because page 4 of the old list is not page 4 of the
 * new one.
 */
export function withList(
  list: FleetListQuery,
  change: Partial<Omit<FleetListQuery, "page">>,
): FleetListQuery {
  return { ...list, ...change, page: 1 };
}

/**
 * The order after a click on a column's header. A new column sorts
 * ascending, a second click descending, and a third returns to newest first.
 * The Started header toggles between newest and oldest first.
 */
export function nextSort(
  list: FleetListQuery,
  key: RunSortKey,
): FleetListQuery {
  if (key === "started")
    return withList(list, {
      sort: "started",
      dir: list.sort === "started" && list.dir === "desc" ? "asc" : "desc",
    });
  if (list.sort !== key) return withList(list, { sort: key, dir: "asc" });
  if (list.dir === "asc") return withList(list, { sort: key, dir: "desc" });
  return withList(list, { sort: "started", dir: "desc" });
}

/**
 * The column each server-sortable header orders by. Run, Summary, Pull
 * requests, Lines, Tokens and Frames are absent: no single SQL order covers
 * them in both stores, so their headers do not sort.
 */
export const SORTABLE_COLUMNS: Partial<Record<FleetColumn, RunSortKey>> = {
  agent: "agent",
  operator: "operator",
  status: "status",
  tier: "tier",
  replay: "replay",
  cost: "cost",
  started: "started",
};

/** Where a list page sits: its first and last row, 1-based; 0 and 0 when empty. */
export function pageRange(
  list: FleetListQuery,
  pageSize: number,
  rows: number,
): { from: number; to: number } {
  if (rows === 0) return { from: 0, to: 0 };
  const from = (list.page - 1) * pageSize + 1;
  return { from, to: from + rows - 1 };
}
