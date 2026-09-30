// Where MCP Studio lives inside Tools (#4678): one page per server at
// `/tools/servers/<mcs_id>`, and each of its four tabs one more segment
// (`/tools/servers/<mcs_id>/connection`). The Tools tabs keep their own
// segments: `/tools/servers` alone is still the Providers tab's old name, and
// parseToolsTab answers it.
import { pathOf, type SafePath } from "@/shared/safe-path";

export const STUDIO_TABS = ["tools", "connection", "try", "changes"] as const;
export type StudioTab = (typeof STUDIO_TABS)[number];

/** The workspace a Studio link points into. */
export type StudioAt = { org: string; ws: string };

export type StudioRoute = { serverId: string; tab: StudioTab };

/** A server is named by its public id, `mcs_` and the id's body (the Tools page's rule). */
const SERVER_ID = /^mcs_[A-Za-z0-9]{1,64}$/;

/**
 * The Studio page a path names.
 *
 * - `undefined`: not a Studio path, so the Tools tabs answer it.
 * - `null`: a Studio path that names no page (a bad id, an unknown tab, or a
 *   deeper path), which is a 404.
 * - a route: the server and the tab, Tools when the path names none.
 */
export function parseStudioRoute(
  segments: readonly string[] | undefined,
): StudioRoute | null | undefined {
  if (segments === undefined || segments.length < 2) return undefined;
  const [first, serverId, tab, ...deeper] = segments;
  if (first !== "servers") return undefined;
  if (serverId === undefined || !SERVER_ID.test(serverId)) return null;
  if (deeper.length > 0) return null;
  if (tab === undefined) return { serverId, tab: "tools" };
  const known = STUDIO_TABS.find((candidate) => candidate === tab);
  return known === undefined ? null : { serverId, tab: known };
}

/** The route of one Studio tab; the Tools tab is the page's own path. */
export function studioHref(
  at: StudioAt,
  serverId: string,
  tab: StudioTab = "tools",
): SafePath {
  return tab === "tools"
    ? pathOf(at.org, at.ws, "tools", "servers", serverId)
    : pathOf(at.org, at.ws, "tools", "servers", serverId, tab);
}
