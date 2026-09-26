// Which Tools view a request asks for: a tab, a category chip and a provider
// chip on the Tools tab, the labels/API-names toggle and a cursor. The tab is
// a path segment (`/tools/providers`), as the rev1 route names it (mockup
// `tools.md`), and the rest are query values. A tab id that is no longer
// served falls back to Tools, so an old link never renders an empty page:
//
//   - `/tools/servers` is the Providers tab's name before rev1 and lands there;
//   - the query tabs this page had before its tabs became segments
//     (`?tab=registry|connections|switches|mandates|autoapprovals`) land on the
//     tab that absorbed each one. Auto-approval rules and the mandates ledger
//     live on Policy, beside the policy versions they are decided with.
import type {
  KillSwitch,
  KillSwitchKind,
  McpServer,
  ToolVersion,
} from "@/data/contracts/tools";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

export const TOOLS_TABS = [
  "tools",
  "toolbelts",
  "providers",
  "policy",
  "switches",
] as const;
export type ToolsTab = (typeof TOOLS_TABS)[number];

/** Every retired tab id, with the tab that absorbed it. */
const TAB_ALIASES: Readonly<Record<string, ToolsTab>> = {
  servers: "providers",
  registry: "tools",
  connections: "providers",
  mandates: "policy",
  autoapprovals: "policy",
};

/**
 * A tab id as the tab it names now: a current id, an alias, or Tools.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function toolsTabOf(raw: string | undefined): ToolsTab {
  if (raw === undefined) return "tools";
  return TOOLS_TABS.find((tab) => tab === raw) ?? TAB_ALIASES[raw] ?? "tools";
}

/**
 * The tab a request names: the path segment when there is one, otherwise the
 * `?tab=` a link written before rev1 carries. Null when the path goes deeper
 * than one segment, which names no page.
 */
export function parseToolsTab(
  segments: readonly string[] | undefined,
  legacyTab: string | undefined,
): ToolsTab | null {
  if (segments === undefined || segments.length === 0) {
    return toolsTabOf(legacyTab);
  }
  if (segments.length > 1) return null;
  return toolsTabOf(segments[0]);
}

/** How a tool version is named in the tables: its human label, or its API name. */
const TOOL_NAME_STYLES = ["labels", "api"] as const;
export type ToolNameStyle = (typeof TOOL_NAME_STYLES)[number];

export type ToolsView = {
  tab: ToolsTab;
  /** Only on the Tools tab: the consequence tag the chips filter by. */
  category: string | null;
  /** Only on the Tools tab: the `mcs_…` id of the provider the rows came from. */
  provider: string | null;
  names: ToolNameStyle;
  /** The `nextCursor` of an earlier page of the tab's own list. */
  cursor: string | null;
  /** Only on the Toolbelts tab: the `tbt_…` id of the belt open below the list (ADR-198). */
  belt: string | null;
};

/** The workspace a link on the page points into. */
export type ToolsAt = { org: string; ws: string };

/** The contract's own tag rule: snake_case, 2 to 64 characters. */
const CATEGORY = /^[a-z][a-z0-9_]{1,63}$/;
/** A provider is named by its server's public id, `mcs_` and the id's body. */
const PROVIDER = /^mcs_[A-Za-z0-9]{1,64}$/;
/** A cursor is opaque; only its shape is checked before it goes back to the kernel. */
const CURSOR = /^[\w.:=+/-]{1,512}$/;
/** A toolbelt is named by its public id, `tbt_` and the id's body (`toolbeltIdSchema`). */
const BELT = /^tbt_[0-9a-z]{1,64}$/;

type Params = Readonly<Record<string, string | string[] | undefined>>;

export function parseToolsView(tab: ToolsTab, params: Params): ToolsView {
  const rawCategory = firstParam(params.category);
  const rawProvider = firstParam(params.provider);
  const rawNames = firstParam(params.names);
  const rawCursor = firstParam(params.cursor);
  const rawBelt = firstParam(params.belt);
  return {
    tab,
    category:
      tab === "tools" && rawCategory !== undefined && CATEGORY.test(rawCategory)
        ? rawCategory
        : null,
    provider:
      tab === "tools" && rawProvider !== undefined && PROVIDER.test(rawProvider)
        ? rawProvider
        : null,
    names: TOOL_NAME_STYLES.find((n) => n === rawNames) ?? "labels",
    cursor:
      rawCursor !== undefined && CURSOR.test(rawCursor) ? rawCursor : null,
    belt:
      tab === "toolbelts" && rawBelt !== undefined && BELT.test(rawBelt)
        ? rawBelt
        : null,
  };
}

/**
 * The route for a view; the defaults (Tools, every category, every provider,
 * labels, page one, no belt open) are left off.
 */
export function toolsLink(
  at: ToolsAt,
  to: {
    tab: ToolsTab;
    category?: string | null;
    provider?: string | null;
    names?: ToolNameStyle;
    cursor?: string | null;
    belt?: string | null;
  },
): SafePath {
  return routes.tools(at.org, at.ws, {
    tab: to.tab === "tools" ? undefined : to.tab,
    category: to.category ?? undefined,
    provider: to.provider ?? undefined,
    names: to.names === "api" ? "api" : undefined,
    cursor: to.cursor ?? undefined,
    belt: to.tab === "toolbelts" ? (to.belt ?? undefined) : undefined,
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

/**
 * A provider's status light (#4132). Green: it answered its last check and,
 * for OAuth, holds a live token. Yellow: connected, with something wrong
 * that does not stop it yet. Red: it cannot be reached or cannot be
 * authenticated to until someone acts.
 */
export type ProviderLight = "green" | "yellow" | "red";

/** Why the light is the colour it is. One reason, the most urgent. */
export type ProviderLightReason =
  | "unreachable"
  | "needsReauth"
  | "revoked"
  | "notConnected"
  | "tokenExpired"
  | "degraded"
  | "tokenLapsed"
  | "unchecked"
  | "ok";

const LIGHT_OF: Record<ProviderLightReason, ProviderLight> = {
  unreachable: "red",
  needsReauth: "red",
  revoked: "red",
  notConnected: "red",
  tokenExpired: "red",
  degraded: "yellow",
  tokenLapsed: "yellow",
  unchecked: "yellow",
  ok: "green",
};

/**
 * The light and its reason, most urgent first: the authorization a person
 * must renew, then reachability, then what renews on its own.
 *
 * An expired access token with a refresh token is yellow, not red: the next
 * call renews it without a person, but the refresh watcher should already
 * have, so it is worth a look. Without a refresh token it is red.
 */
export function providerLight(
  server: Pick<McpServer, "healthStatus" | "authorization">,
  now: number,
): { light: ProviderLight; reason: ProviderLightReason } {
  const auth = server.authorization;
  // A lapsed access token either renews on the next call or waits on a person.
  const lapsed =
    auth === null || auth.expiresAt === null || Date.parse(auth.expiresAt) > now
      ? null
      : auth.refreshable
        ? "renews"
        : "stuck";
  const reason: ProviderLightReason =
    auth?.state === "needs_reauth"
      ? "needsReauth"
      : auth?.state === "revoked"
        ? "revoked"
        : auth?.state === "not_connected"
          ? "notConnected"
          : lapsed === "stuck"
            ? "tokenExpired"
            : server.healthStatus === "unreachable"
              ? "unreachable"
              : server.healthStatus === "degraded"
                ? "degraded"
                : lapsed === "renews"
                  ? "tokenLapsed"
                  : server.healthStatus === "unknown"
                    ? "unchecked"
                    : "ok";
  return { light: LIGHT_OF[reason], reason };
}

/** True when the fix is a person signing in again: every red OAuth reason. */
export function needsReconnect(reason: ProviderLightReason): boolean {
  return (
    reason === "needsReauth" ||
    reason === "revoked" ||
    reason === "notConnected" ||
    reason === "tokenExpired"
  );
}
