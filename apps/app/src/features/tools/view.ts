// Which Tools view a request asks for (#2958): a tab, a category chip on
// Registry, the labels/API-names toggle and a cursor, all from the query
// string. A tab is a query rather than a route (ARCHITECTURE.md §1.2: this
// lane adds no route), and a value the page does not know falls back to the
// default rather than failing the page.
//
// Five of the mockup's six tabs are backed today: the three #2958's
// capabilities back, the Mandates ledger #2957 brought, and Auto-approvals
// over the ADR-070 rule set. Policy is still its own lane; it adds its name to
// TOOLS_TABS and its case to the body, and nothing else here moves.
import type {
  KillSwitch,
  KillSwitchKind,
  ToolVersion,
} from "@/data/contracts/tools";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

export const TOOLS_TABS = [
  "registry",
  "connections",
  "switches",
  "mandates",
  "autoapprovals",
] as const;
export type ToolsTab = (typeof TOOLS_TABS)[number];

/** How a tool version is named in the tables: its human label, or its API name. */
const TOOL_NAME_STYLES = ["labels", "api"] as const;
export type ToolNameStyle = (typeof TOOL_NAME_STYLES)[number];

export type ToolsView = {
  tab: ToolsTab;
  /** Only on Registry: the consequence tag the chips filter by. */
  category: string | null;
  names: ToolNameStyle;
  /** The `nextCursor` of an earlier page of the tab's own list. */
  cursor: string | null;
};

/** The workspace a link on the page points into. */
export type ToolsAt = { org: string; ws: string };

/** The contract's own tag rule: snake_case, 2 to 64 characters. */
const CATEGORY = /^[a-z][a-z0-9_]{1,63}$/;
/** A cursor is opaque; only its shape is checked before it goes back to the kernel. */
const CURSOR = /^[\w.:=+/-]{1,512}$/;

type Params = Readonly<Record<string, string | string[] | undefined>>;

export function parseToolsView(params: Params): ToolsView {
  const rawTab = firstParam(params.tab);
  const tab = TOOLS_TABS.find((t) => t === rawTab) ?? "registry";
  const rawCategory = firstParam(params.category);
  const rawNames = firstParam(params.names);
  const rawCursor = firstParam(params.cursor);
  return {
    tab,
    category:
      tab === "registry" &&
      rawCategory !== undefined &&
      CATEGORY.test(rawCategory)
        ? rawCategory
        : null,
    names: TOOL_NAME_STYLES.find((n) => n === rawNames) ?? "labels",
    cursor:
      rawCursor !== undefined && CURSOR.test(rawCursor) ? rawCursor : null,
  };
}

/** The route for a view; the defaults (Registry, every category, labels, page one) are left off. */
export function toolsLink(
  at: ToolsAt,
  to: {
    tab: ToolsTab;
    category?: string | null;
    names?: ToolNameStyle;
    cursor?: string | null;
  },
): SafePath {
  return routes.tools(at.org, at.ws, {
    tab: to.tab === "registry" ? undefined : to.tab,
    category: to.category ?? undefined,
    names: to.names === "api" ? "api" : undefined,
    cursor: to.cursor ?? undefined,
  });
}

/**
 * The scope a switch at this level is recorded under, as the record scopes it
 * (`switchWorkspaceOf`, packages/handlers/src/kill_switch.set.ts): a switch
 * over a tool version, a tool server, a connection or an agent is written
 * under the caller's workspace; class, organization, workspace and operator
 * switches are written org-wide, because each of them reaches past one
 * workspace.
 *
 * It is what names the generation a flip advances, so the dialog's preview and
 * the card's "takes effect" read the same counter for the same level.
 */
export function switchScopeOf(kind: KillSwitchKind): KillSwitch["scope"] {
  switch (kind) {
    case "tool_version":
    case "tool_server":
    case "connection":
    case "agent":
      return "workspace";
    case "class":
    case "org":
    case "workspace":
    case "operator":
      return "org";
  }
}

/**
 * The two levels whose target the page supplies itself. There is one
 * organization and one workspace in view; the contract wants their database
 * uuids, and this page never prints a uuid (INV-11), so the dialog asks for no
 * target at these levels and the server action fills it in from the viewer.
 */
export const SELF_TARGETED_KINDS: ReadonlySet<KillSwitchKind> = new Set([
  "org",
  "workspace",
]);

/** One field's text, or the empty string when the form does not carry it. */
export function textValue(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

/**
 * The version's identity on the wire: `slug@version`, the one spelling
 * everywhere (the registry table, the tool dialog, a kill switch's target).
 */
export function versionLabel(version: ToolVersion): string {
  return `${version.slug}@${String(version.version)}`;
}

/**
 * A newline-separated list as the values the contract wants, in order, each
 * line trimmed and blank lines dropped.
 *
 * Data classes are free text — `z.string().min(1).max(64)`, so `customer
 * financial data` is one class — and cannot go through `splitTags`, which
 * splits on whitespace and would turn that one class into three the next time
 * anyone saved the form for any reason. One value per line is the one
 * separator a data class cannot itself contain.
 *
 * No de-duplication: the contract permits a repeat here (only consequence tags
 * are refined to appear once), and dropping one would edit a record the person
 * did not ask to change.
 */
export function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** A comma- or whitespace-separated list as the tags the contract wants, each once. */
export function splitTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
    ),
  ];
}

/**
 * A comma-separated list as the values it names, in order, each trimmed, blank
 * entries dropped, and each value once.
 *
 * A target glob is `z.string().min(1).max(256)`, so `vendor:* prod` is one
 * legal glob. It cannot go through `splitTags`, which also splits on
 * whitespace: that would turn the one glob into `vendor:*` and `prod`, and the
 * first of those admits every vendor target the author did not write. The
 * comma is the delimiter the allow-list hint documents and the one the editor
 * writes the stored globs back with.
 */
export function splitCommas(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== ""),
    ),
  ];
}

/**
 * True when `split` gives `values` back, one for one and in order, from the
 * text a field shows them as: `values.join(separator)`.
 *
 * A form that shows a stored list as delimited text and reads it back has one
 * value it cannot carry: one that contains the delimiter. A target glob and a
 * tool pattern are each `z.string().min(1).max(256)`, so `vendor:*,prod` is one
 * legal glob, and a comma-separated field shows it as two globs, the first of
 * which admits every vendor target the author did not write. The only sound
 * test is the round trip itself, so a stored list is edited in a field only
 * when this says the field would write it back unchanged.
 */
export function carriedBy(
  values: readonly string[],
  separator: string,
  split: (raw: string) => string[],
): boolean {
  const back = split(values.join(separator));
  return (
    back.length === values.length &&
    back.every((value, index) => value === values[index])
  );
}

/**
 * `measure = value` lines as the pairs they name, in order, or null when a
 * line has no `=`, an empty side, or repeats a measure.
 *
 * The auto-approval dialog writes its ceilings and allow lists this way, one
 * measure per line. A malformed line is refused whole rather than skipped,
 * because a rule that silently lost a ceiling releases more calls than the
 * person wrote it to.
 */
export function parseMeasureLines(
  raw: string,
): readonly (readonly [measure: string, value: string])[] | null {
  const pairs: (readonly [string, string])[] = [];
  const seen = new Set<string>();
  for (const line of splitLines(raw)) {
    const at = line.indexOf("=");
    if (at < 0) return null;
    const measure = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (measure === "" || value === "" || seen.has(measure)) return null;
    seen.add(measure);
    pairs.push([measure, value]);
  }
  return pairs;
}

/** ISO weekdays as `tools.autoApprovals.days` keys them, Monday first. */
const WEEKDAY_KEYS = ["1", "2", "3", "4", "5", "6", "7"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/**
 * The catalogue key for an ISO weekday (1 is Monday, 7 is Sunday). The return
 * is a literal union rather than `String(day)`, so the translator's key type
 * and the catalog-used arch test can both see which keys are read. The
 * contract bounds a rule's days to 1–7, so any other value is a bug upstream.
 */
export function weekdayKey(day: number): WeekdayKey {
  const key = WEEKDAY_KEYS[day - 1];
  if (key === undefined) {
    throw new RangeError(`not an ISO weekday: ${String(day)}`);
  }
  return key;
}

/**
 * The credential schemes the add-connection dialog can collect, and the fields
 * each one needs, in the order the form shows them.
 *
 * `create_connection` takes the credential as an open record, so the set of
 * schemes a form can offer is decided here rather than by the contract. These
 * four are the ones whose fields are plain text a person can be asked for; a
 * service-account JSON, an SSH key pair or an AWS role is created over the API
 * until a form can collect it without pasting a key into a text box.
 *
 * The connectors read the credential's `scheme` (`AuthCredential`,
 * packages/ingestion/src/connectors/types.ts) and `create_connection` records
 * the connection's `authScheme` from the credential's `type`, so the action
 * sends both, set to the scheme the person picked.
 */
export const CONNECTION_SCHEMES = {
  api_key: ["apiKey"],
  bearer_token: ["token"],
  basic_auth: ["username", "password"],
  connection_string: ["connectionString"],
} as const satisfies Record<string, readonly string[]>;

export type ConnectionScheme = keyof typeof CONNECTION_SCHEMES;

/**
 * The schemes in the order the select offers them. Written out rather than
 * taken from `Object.keys`, which types its answer as `string[]` and would
 * need an assertion to get the union back.
 */
export const CONNECTION_SCHEME_NAMES = [
  "api_key",
  "bearer_token",
  "basic_auth",
  "connection_string",
] as const satisfies readonly ConnectionScheme[];

/** The scheme the dialog opens on, and what an unreadable form value falls back to. */
export const DEFAULT_CONNECTION_SCHEME: ConnectionScheme = "api_key";

/** A form value as one of the schemes the dialog offers, or the default. */
export function connectionSchemeOf(raw: string): ConnectionScheme {
  return (
    CONNECTION_SCHEME_NAMES.find((scheme) => scheme === raw) ??
    DEFAULT_CONNECTION_SCHEME
  );
}
