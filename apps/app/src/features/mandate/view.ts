// Which view of one mandate's ledger a request asks for (#2957): a search, a
// facet on the movement state, and a page. All three are query values on the
// one route, not routes of their own (ARCHITECTURE.md §1.2), and a value the
// page does not recognise falls back to the default rather than failing the
// page.
//
// **The search, the facet and the pager all run over the rows already read,
// and that is a property of the contract rather than a shortcut.**
// `get_mandate` takes a `ledgerLimit` and nothing else: no filter, no cursor,
// no full-text argument. So there is no narrower read to make — the page holds
// the newest `ledgerLimit` movements and answers all three questions from them.
// Two consequences the page states rather than hides:
//
//   - A search finds nothing beyond the movements that were read. On a mandate
//     drawn on more times than the bound, `MandateDetail.truncatedAt` is set and
//     the table says so above the rows, so "no match" is never read as "no such
//     movement".
//   - The tiles are never sums of the filtered rows. Remaining authority is the
//     ledger's own accounting (INV-10), carried on `MandateRow.authority`, so a
//     search cannot move a figure in a tile. That is the point of the rule that
//     a header is a rollup of the rows beneath it: here the rollup is the
//     record's, and the rows are a view of it.
//
// Paging this read properly wants a cursor and a state filter on `get_mandate`
// itself; until then this is the honest shape.
import type { MandateLedgerRow, MandateMovement } from "@/data/contracts/mandates";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

/** The movement states the facet offers, in the order a draw moves through them. */
export const MOVEMENT_STATES: readonly MandateMovement[] = [
  "reserve",
  "settle",
  "release",
];

/** How many movements one page of the table shows. */
export const LEDGER_PAGE = 25;

export type MandateView = {
  /** The search text, trimmed; null when the box is empty. */
  search: string | null;
  /** The movement state the facet narrows to; null for every state. */
  state: MandateMovement | null;
  /** How many movements the page skips, a multiple of LEDGER_PAGE. */
  offset: number;
};

/** Where a link on this page points. */
export type MandateAt = {
  org: string;
  ws: string;
  /** The agent's slug, as the URL names it. */
  agent: string;
  /** The mandate's public id. */
  mandate: string;
};

/**
 * The public-id shape `mandateIdSchema` accepts (`mnd_…`). The page checks it
 * before reading, so a URL that could never name a mandate is a 404 rather than
 * a kernel `invalid_input` rendered as a page error: the two are different
 * answers and a reader deserves the right one.
 */
export const MANDATE_ID = /^mnd_[0-9a-z]+$/i;

/** A search is bounded so a crafted URL cannot hand the filter an unbounded string. */
const SEARCH_MAX = 200;

type Params = Readonly<Record<string, string | string[] | undefined>>;

export function parseMandateView(params: Params): MandateView {
  const rawSearch = firstParam(params.q)?.trim();
  const rawState = firstParam(params.state);
  const rawOffset = firstParam(params.offset);
  const offset =
    rawOffset !== undefined && /^\d{1,6}$/.test(rawOffset)
      ? Math.floor(Number(rawOffset) / LEDGER_PAGE) * LEDGER_PAGE
      : 0;
  return {
    search:
      rawSearch === undefined || rawSearch === ""
        ? null
        : rawSearch.slice(0, SEARCH_MAX),
    state: MOVEMENT_STATES.find((state) => state === rawState) ?? null,
    offset,
  };
}

/** The route for a view; the defaults (no search, every state, page one) are left off. */
export function mandateLink(
  at: MandateAt,
  to: Partial<MandateView> = {},
): SafePath {
  const search = to.search ?? null;
  const state = to.state ?? null;
  const offset = to.offset ?? 0;
  return routes.mandate(at.org, at.ws, at.agent, at.mandate, {
    search: search === null ? undefined : search,
    state: state === null ? undefined : state,
    offset: offset === 0 ? undefined : String(offset),
  });
}

/**
 * Whether a movement answers the search. It matches the measure and the
 * external effect id and nothing else, because those are the only two strings
 * on the row a person could be looking for: the state has its own facet, the
 * figure is a number in a measure's own units, and the row carries no tool name
 * (`MandateLedgerRow`). Matching is case-insensitive, and on the value as
 * recorded — no normalisation, so what is typed is compared with what is shown.
 */
function matches(row: MandateLedgerRow, search: string): boolean {
  const needle = search.toLowerCase();
  return (
    row.measure.toLowerCase().includes(needle) ||
    (row.externalEffectId !== null &&
      row.externalEffectId.toLowerCase().includes(needle))
  );
}

export type LedgerPage = {
  rows: readonly MandateLedgerRow[];
  /** How many movements the search and the facet left, before paging. */
  total: number;
  offset: number;
  /** Whether a later page exists. */
  hasMore: boolean;
};

/** The rows this view shows, and what it is a page of. */
export function ledgerPage(
  ledger: readonly MandateLedgerRow[],
  view: MandateView,
): LedgerPage {
  const selected = ledger.filter(
    (row) =>
      (view.state === null || row.kind === view.state) &&
      (view.search === null || matches(row, view.search)),
  );
  // An offset past the end shows the last page rather than an empty table: a
  // link is the only way to reach one, and a blank page would read as a mandate
  // with no movements.
  const offset = view.offset >= selected.length ? 0 : view.offset;
  return {
    rows: selected.slice(offset, offset + LEDGER_PAGE),
    total: selected.length,
    offset,
    hasMore: offset + LEDGER_PAGE < selected.length,
  };
}
