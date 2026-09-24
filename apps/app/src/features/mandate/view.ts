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
  MandateDraw,
  MandateMovement,
  MandateRow,
  MeasureValue,
} from "@/data/contracts/mandates";
import { compareIntegers } from "@/data/contracts/money";
import {
  endOfZonedDay,
  startOfNextZonedDay,
  startOfZonedDay,
  supportsTimeZone,
} from "@/shared/calendar-day";
import { pathOf, routes, type SafePath } from "@/shared/safe-path";

/** The draw states the facet offers, in the order a draw moves through them. */
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
const CALLS_MEASURE = "calls";

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
  /** The draw state the facet narrows to; null for every state. */
  state: MandateMovement | null;
  /** Rows per page; 0 is All. The toolbar offers `PAGE_SIZES`. */
  size: number;
  /** The zero-based page. */
  page: number;
  /** The column the header sorts on and its direction; null keeps the server's order, newest first. */
  sort?: LedgerSort | null;
};

/** The columns a ledger header can sort on: the ones whose cells carry a recorded value. */
export type SortableColumn = "when" | "amount" | "state" | "external";
export type LedgerSort = { column: SortableColumn; dir: 1 | -1 };

/**
 * The next sort a header click gives (the design's `th.sortable`): ascending,
 * then descending, then back to the server's order.
 */
export function nextSort(
  was: LedgerSort | null | undefined,
  column: SortableColumn,
): LedgerSort | null {
  if (was === null || was === undefined || was.column !== column)
    return { column, dir: 1 };
  return was.dir === 1 ? { column, dir: -1 } : null;
}

/**
 * What a draw cost: its value, except on a released draw, which moved nothing
 * and so cost zero in the same currency or unit (the design prints `$0.00` on a
 * released row). The figure the reservation held is still the row's `value`,
 * and the table prints it beside the zero so the release says what it gave
 * back. A reader summing the Amount column gets what the mandate paid.
 */
export function costOf(row: MandateDraw): MeasureValue {
  if (row.state !== "release") return row.value;
  return row.value.kind === "money"
    ? { kind: "money", money: { ...row.value.money, micros: "0" } }
    : { kind: "count", count: "0", unit: row.value.unit };
}

/** A draw's cost as an integer string in its smallest unit: micros for money, the count itself otherwise. */
function amountOf(row: MandateDraw): string {
  const cost = costOf(row);
  return cost.kind === "money" ? cost.money.micros : cost.count;
}

const STATE_ORDER: Record<MandateMovement, number> = {
  reserve: 0,
  settle: 1,
  release: 2,
};

/**
 * Orders two draws on one column. Amounts on different measures never compare
 * as numbers (dollars and recipients are not one scale), so they group by
 * measure first. A draw with no external reference sorts after one with a
 * reference.
 */
function compareOn(
  a: MandateDraw,
  b: MandateDraw,
  column: SortableColumn,
): number {
  switch (column) {
    case "when":
      return Date.parse(a.at) - Date.parse(b.at);
    case "amount": {
      if (a.measure !== b.measure) return a.measure.localeCompare(b.measure);
      return compareIntegers(amountOf(a), amountOf(b));
    }
    case "state":
      return STATE_ORDER[a.state] - STATE_ORDER[b.state];
    case "external": {
      if (a.externalEffectRef === b.externalEffectRef) return 0;
      if (a.externalEffectRef === null) return 1;
      if (b.externalEffectRef === null) return -1;
      return a.externalEffectRef.localeCompare(b.externalEffectRef);
    }
  }
}

/**
 * Whether a draw answers the search. It matches the measure and the external
 * effect reference, the only two strings on a row a person could be looking
 * for, case-insensitively and on the value as recorded.
 */
function matches(row: MandateDraw, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;
  return (
    row.measure.toLowerCase().includes(needle) ||
    (row.externalEffectRef !== null &&
      row.externalEffectRef.toLowerCase().includes(needle))
  );
}

export type LedgerPage = {
  rows: readonly MandateDraw[];
  /** How many draws the search and the facet left, before paging. */
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
  draws: readonly MandateDraw[],
  view: LedgerView,
): LedgerPage {
  const filtered = draws.filter(
    (row) =>
      (view.state === null || row.state === view.state) &&
      matches(row, view.search),
  );
  const sort = view.sort ?? null;
  // Ties keep the server's order, so a sort never shuffles equal rows.
  const selected =
    sort === null
      ? filtered
      : filtered
          .map((row, index) => ({ row, index }))
          .sort(
            (p, q) =>
              compareOn(p.row, q.row, sort.column) * sort.dir ||
              p.index - q.index,
          )
          .map(({ row }) => row);
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

/**
 * How many calls hold a reservation on a measure now, or null when the read
 * cannot say. The bar names one open reservation "reserved by this call", as
 * the design does, and more than one "reserved by N calls in flight"; a read
 * that filled its bound may be missing an older open draw, so it answers null
 * and the bar keeps the words that are true either way.
 */
export function openCalls(
  draws: readonly MandateDraw[],
  measure: string,
  readBound: number | null,
): number | null {
  if (readBound !== null) return null;
  return draws.filter((d) => d.measure === measure && d.state === "reserve")
    .length;
}

/**
 * The calendar day an instant falls on in a zone, as `YYYY-MM-DD`: the form the
 * design prints and `<input type="date">` takes. Null for a zone this runtime
 * cannot read, so a caller falls back to the formatter rather than guessing UTC.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function zonedDay(instant: string, timeZone: string): string | null {
  if (!supportsTimeZone(timeZone)) return null;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value;
  const [year, month, day] = [part("year"), part("month"), part("day")];
  if (year === undefined || month === undefined || day === undefined)
    return null;
  return `${year}-${month}-${day}`;
}

/**
 * The last day a mandate may be drawn on: the day holding the last instant
 * before its exclusive `validTo`. It prefills the edit dialog's Valid to, and
 * `changeMandateLimits` turns a picked day back into that day's end.
 */
export function lastDayOf(validTo: string, timeZone: string): string | null {
  const at = Date.parse(validTo);
  if (Number.isNaN(at)) return null;
  return zonedDay(new Date(at - 1).toISOString(), timeZone);
}

/**
 * The validity window as the design prints it, `2026-09-01 → 2026-12-31`, when
 * each end sits on a day boundary in the viewer's zone, so that a day names it
 * exactly. An end that falls inside a day is null, and the caller prints its
 * date and time: enforcement's window is half-open (`isEffective`), and a
 * mandate that ends at 14:00 has not given the rest of that day.
 */
export function validDays(
  mandate: Pick<MandateRow, "validFrom" | "validTo">,
  timeZone: string,
): { from: string | null; to: string | null } {
  const fromDay = zonedDay(mandate.validFrom, timeZone);
  const from =
    fromDay !== null &&
    startOfZonedDay(fromDay, timeZone) ===
      new Date(Date.parse(mandate.validFrom)).toISOString()
      ? fromDay
      : null;
  const toDay = lastDayOf(mandate.validTo, timeZone);
  const end = new Date(Date.parse(mandate.validTo)).toISOString();
  const to =
    toDay !== null &&
    (endOfZonedDay(toDay, timeZone) === end ||
      startOfNextZonedDay(toDay, timeZone) === end)
      ? toDay
      : null;
  return { from, to };
}

/**
 * The design's When cell: the time for a draw on the day the page read the
 * ledger (`09:31:08`), the day for an older one (`2026-09-04`). Null for a zone
 * this runtime cannot read.
 */
export function whenOf(
  at: string,
  asOf: string,
  timeZone: string,
): { kind: "time" | "day"; text: string } | null {
  const day = zonedDay(at, timeZone);
  if (day === null) return null;
  if (day !== zonedDay(asOf, timeZone)) return { kind: "day", text: day };
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(Date.parse(at)));
  return { kind: "time", text };
}

/**
 * The error state's trace time as the design prints it: `2026-09-11 09:16:04Z`,
 * the instant in UTC to the second. The Billing lane prints its trace line by
 * the same rule (`traceTime` in `features/billing/billing.tsx`).
 */
export function traceTime(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace("T", " ")}Z`;
}
