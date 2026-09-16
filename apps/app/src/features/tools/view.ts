// Which Tools view a request asks for (#2958): a tab, a category chip on
// Registry, the labels/API-names toggle and a cursor, all from the query
// string. A tab is a query rather than a route (ARCHITECTURE.md §1.2: this
// lane adds no route), and a value the page does not know falls back to the
// default rather than failing the page.
//
// The three tabs this lane ships are the three the six #2958 capabilities
// back. Mandates ledger, Policy and Auto-approvals are their own lanes; each
// adds its name to TOOLS_TABS and its case to the body, and nothing else here
// moves.
import type { ToolVersion } from "@/data/contracts/tools";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

export const TOOLS_TABS = ["registry", "connections", "switches"] as const;
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
