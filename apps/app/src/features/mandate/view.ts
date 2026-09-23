// The pure questions the mandate page asks of its one record (#2957; the
// design's `pMandate`): which route it was reached by, which measure the tiles
// and the dialog speak for, and which rows one view of the ledger shows.
//
// **The search, the facet, the rows-per-page choice and the pager all run over
// the rows already read, and that is a property of the contract.** `get_mandate`
// takes a `ledgerLimit` and nothing else: no filter, no cursor, no full-text
// argument. So the page holds the newest `ledgerLimit` movements and answers
// all four questions from them, in the browser, without another read. The
// tiles are never sums of the filtered rows: remaining authority is the
// ledger's own accounting (INV-10), carried on `MandateRow.authority`, so a
// search cannot move a figure in a tile.
import type {
  MandateAuthority,
  MandateLedgerRow,
  MandateMovement,
  MandateRow,
  MeasureValue,
} from "@/data/contracts/mandates";
import { pathOf, routes, type SafePath } from "@/shared/safe-path";

/** The movement states the facet offers, in the order a draw moves through them. */
export const MOVEMENT_STATES: readonly MandateMovement[] = [
  "reserve",
  "settle",
  "release",
];

/** The design's rows-per-page choices; `0` is All. */
export const PAGE_SIZES = [5, 10, 25, 50, 0] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** The page size the table opens with, as the design's selector does. */
export const DEFAULT_PAGE_SIZE: PageSize = 10;

/**
 * Where the page was reached. The design's route nests the mandate under the
 * agent it was granted to (`/agents/<slug>/mandates/<id>`); the flat route
 * (`/mandates/<id>`) is the one every other surface links to. Both render this
 * page. `agent` is set only on the nested route, and the page checks it against
 * the record, so the agent segment is a checked name rather than a second,
 * unchecked one.
 */
export type MandateAt = {
  org: string;
  ws: string;
  /** The mandate's public id. */
  mandate: string;
  /** The agent slug the nested route names; null on the flat route. */
  agent: string | null;
};

/**
 * The public-id shape `mandateIdSchema` accepts (`mnd_…`). The page checks it
 * before reading, so a URL that could never name a mandate is a 404 rather than
 * a kernel `invalid_input` rendered as a page error.
 */
export const MANDATE_ID = /^mnd_[0-9a-z]+$/i;

/** The route this page was reached by: Try again points back at it. */
export function mandateLink(at: MandateAt): SafePath {
  return at.agent === null
    ? routes.mandate(at.org, at.ws, at.mandate)
    : pathOf(at.org, at.ws, "agents", at.agent, "mandates", at.mandate);
}

/** The built-in measure every call draws one of (`CALLS_MEASURE`). */
export const CALLS_MEASURE = "calls";

/**
 * The measures a mandate limits, split the way the design reads them: the one
 * measure the tiles and the dialog speak for, the built-in calls cap, and any
 * other measure the grant also limits.
 *
 * The primary measure is the first limited measure that is not `calls`, in the
 * order the record lists them; a mandate that caps calls alone speaks for
 * `calls`. The design's mandate has one money measure and a calls cap, which is
 * the common shape, and a mandate with a second measure lists it under each tile
 * rather than dropping it.
 */
export type MandateMeasures = {
  primary: MandateAuthority | null;
  /** The calls cap, when the mandate has one beside another measure. */
  calls: MandateAuthority | null;
  others: readonly MandateAuthority[];
};

export function measuresOf(mandate: MandateRow): MandateMeasures {
  const named = mandate.authority.filter((a) => a.measure !== CALLS_MEASURE);
  const calls =
    mandate.authority.find((a) => a.measure === CALLS_MEASURE) ?? null;
  const [first, ...rest] = named;
  if (first === undefined) return { primary: calls, calls: null, others: [] };
  return { primary: first, calls, others: rest };
}

/** Whether a measure is money, read from the kind the record carries (ADR-108). */
export function kindOf(authority: MandateAuthority): MeasureValue["kind"] {
  return authority.settled.kind;
}

/**
 * The unit a measure's figures are written in: the ISO 4217 code for money,
 * the unit's own name for a count. It labels the dialog's fields and the
 * header's currency badge.
 */
export function unitOf(authority: MandateAuthority): string {
  const value = authority.settled;
  return value.kind === "money" ? value.money.currency : value.unit;
}

/** The currencies and units a mandate's limits are written in, deduplicated. */
export function unitsOf(mandate: MandateRow): string[] {
  return [
    ...new Set(
      mandate.authority
        .filter((a) => a.measure !== CALLS_MEASURE)
        .map((a) => unitOf(a)),
    ),
  ];
}

/** Whether the ledger holds anything under this figure; both forms are integer strings. */
export function isDrawn(value: MeasureValue): boolean {
  const digits = value.kind === "money" ? value.money.micros : value.count;
  return /[1-9]/.test(digits);
}

/**
 * A figure as the digits a person types back into a field: micros as a
 * decimal with at least two places ("250.00", "0.005"), a count as its own
 * digits. No grouping separator, so the value round-trips through
 * `microsFromDecimal` unchanged.
 */
export function editableOf(value: MeasureValue | null): string {
  if (value === null) return "";
  if (value.kind === "count") return value.count;
  const digits = value.money.micros.replace(/^-/, "").padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-6).replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}

/**
 * The approval threshold the mandate's own rule sets on a measure, as the
 * record stores it, or null when the rule sets none.
 */
export function thresholdOf(
  mandate: MandateRow,
  measure: string,
): MandateRow["approval"]["humanAbove"][number] | null {
  return mandate.approval.humanAbove.find((t) => t.measure === measure) ?? null;
}

/** One view of the ledger: what the toolbar above the table selects. */
export type LedgerView = {
  /** The search text as typed; blank matches every row. */
  search: string;
  /** The movement state the facet narrows to; null for every state. */
  state: MandateMovement | null;
  /** Rows per page; 0 is All. The toolbar offers `PAGE_SIZES`. */
  size: number;
  /** The zero-based page. */
  page: number;
};

/**
 * Whether a movement answers the search. It matches the measure and the
 * external effect reference, the only two strings on a row a person could be
 * looking for, case-insensitively and on the value as recorded.
 */
function matches(row: MandateLedgerRow, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;
  return (
    row.measure.toLowerCase().includes(needle) ||
    (row.externalEffectRef !== null &&
      row.externalEffectRef.toLowerCase().includes(needle))
  );
}

export type LedgerPage = {
  rows: readonly MandateLedgerRow[];
  /** How many movements the search and the facet left, before paging. */
  total: number;
  /** The zero-based page shown, clamped to the pages that exist. */
  page: number;
  pages: number;
  /** One-based positions of the first and last row shown; 0 when none is. */
  from: number;
  to: number;
};

/** The rows this view shows, and what it is a page of. */
export function ledgerPage(
  ledger: readonly MandateLedgerRow[],
  view: LedgerView,
): LedgerPage {
  const selected = ledger.filter(
    (row) =>
      (view.state === null || row.kind === view.state) &&
      matches(row, view.search),
  );
  const total = selected.length;
  const size = view.size === 0 ? Math.max(total, 1) : view.size;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(view.page, 0), pages - 1);
  const start = page * size;
  const rows = selected.slice(start, start + size);
  return {
    rows,
    total,
    page,
    pages,
    from: rows.length === 0 ? 0 : start + 1,
    to: start + rows.length,
  };
}
