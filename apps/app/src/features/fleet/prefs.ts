// What a person chose about the Fleet runs table: which columns it shows and
// how many runs a page reads. A cookie remembers both, so every later visit
// opens the table the way it was left. The page reads the cookie on the
// server, so the first render already has the choice and nothing reflows
// after it loads.
//
// The cookie holds the columns a person HID, not the ones shown. A column
// added to the table later then appears for everyone, rather than staying
// hidden from every person who ever saved a choice. Anything in the cookie
// this build does not know (a retired column, a size the select no longer
// offers, a value from a future format) is ignored, and the default stands.
//
// Format: `v1|<page size>|<hidden column>~<hidden column>…`. Every character
// is a cookie-octet (RFC 6265 §4.1.1), so the value needs no encoding.

/** Every column the table can show, in the order it draws them. */
export const FLEET_COLUMNS = [
  "run",
  "summary",
  "agent",
  "operator",
  "status",
  "pullRequests",
  "diff",
  "tier",
  "replay",
  "tokens",
  "cost",
  "frames",
  "started",
] as const;
export type FleetColumn = (typeof FLEET_COLUMNS)[number];

/**
 * The column that names the run. It opens the run and carries its id, so a
 * table without it would list rows nobody can tell apart; it cannot be hidden.
 */
export const FIXED_COLUMN: FleetColumn = "run";

/** Runs one Fleet page reads. The contract answers at most 100. */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 25;

export type FleetPrefs = {
  pageSize: PageSize;
  /** The columns hidden; never holds the fixed column. */
  hidden: ReadonlySet<FleetColumn>;
};

export const DEFAULT_FLEET_PREFS: FleetPrefs = {
  pageSize: DEFAULT_PAGE_SIZE,
  hidden: new Set(),
};

export const FLEET_PREFS_COOKIE = "fleet_view";
const VERSION = "v1";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function isColumn(value: string): value is FleetColumn {
  return FLEET_COLUMNS.some((column) => column === value);
}

/** The page size a select's value or a cookie names; anything else is the default. */
export function pageSizeOf(value: string | undefined): PageSize {
  const n = Number(value);
  return PAGE_SIZES.find((size) => size === n) ?? DEFAULT_PAGE_SIZE;
}

/**
 * The choice a cookie value holds, or the defaults when it holds nothing this
 * build can read. Unknown columns are dropped one by one; the rest stand.
 */
export function readFleetPrefs(raw: string | undefined): FleetPrefs {
  if (raw === undefined) return DEFAULT_FLEET_PREFS;
  const [version, size, hidden = ""] = raw.split("|");
  if (version !== VERSION) return DEFAULT_FLEET_PREFS;
  return {
    pageSize: pageSizeOf(size),
    hidden: new Set(
      hidden
        .split("~")
        .filter(isColumn)
        .filter((column) => column !== FIXED_COLUMN),
    ),
  };
}

/** The cookie value for a choice, columns in table order so equal choices write equal text. */
export function fleetPrefsValue(prefs: FleetPrefs): string {
  const hidden = FLEET_COLUMNS.filter(
    (column) => column !== FIXED_COLUMN && prefs.hidden.has(column),
  );
  return [VERSION, String(prefs.pageSize), hidden.join("~")].join("|");
}

/** The `document.cookie` assignment that remembers a choice for a year, on every page of the app. */
export function fleetPrefsCookieString(
  prefs: FleetPrefs,
  secure: boolean,
): string {
  return `${FLEET_PREFS_COOKIE}=${fleetPrefsValue(prefs)}; Path=/; Max-Age=${String(ONE_YEAR_SECONDS)}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The columns a table with this choice draws, in table order. */
export function shownColumns(prefs: FleetPrefs): FleetColumn[] {
  return FLEET_COLUMNS.filter((column) => !prefs.hidden.has(column));
}

/** A choice with one column shown or hidden; the fixed column never hides. */
export function withColumn(
  prefs: FleetPrefs,
  column: FleetColumn,
  shown: boolean,
): FleetPrefs {
  if (column === FIXED_COLUMN) return prefs;
  const hidden = new Set(prefs.hidden);
  if (shown) hidden.delete(column);
  else hidden.add(column);
  return { ...prefs, hidden };
}

/** The pull-request filter a query value names; anything else lists every run. */
export function pullRequestFilterOf(
  value: string | undefined,
): "any" | "with" | "without" {
  return value === "with" || value === "without" ? value : "any";
}
