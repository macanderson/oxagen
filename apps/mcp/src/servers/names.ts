// names.ts: which served tool a tools/call name means (lane M15;
// mcp-studio-spec, Large servers).
//
// A full name is <server>__<key>. A server name may hold underscores, so the
// name is matched against each server's prefix, not split on the first
// double underscore. In search mode the server's search, describe, and call
// win over a tool with the same key.
import { SEARCH_MODE_TOOLS, type ManifestServer } from "@oxagen/mcp-studio";
import type { ServedTool, ServedView } from "./snapshot";

export type SearchModeTool = (typeof SEARCH_MODE_TOOLS)[number];

export type ResolvedName =
  | { kind: "tool"; entry: ServedTool }
  | { kind: SearchModeTool; server: ManifestServer };

function isSearchModeTool(key: string): key is SearchModeTool {
  return (SEARCH_MODE_TOOLS as readonly string[]).includes(key);
}

/** The imported tool a full name names, whether or not it is served. */
export function findTool(view: ServedView, name: string): ServedTool | null {
  return view.tools.find((entry) => entry.tool.name === name) ?? null;
}

/**
 * What a tools/call name means, or null when it names no published server.
 * A null name is left to Oxagen's own tools.
 */
export function resolveName(view: ServedView, name: string): ResolvedName | null {
  const servers = view.published?.manifest?.servers ?? [];
  for (const server of servers) {
    const prefix = `${server.name}__`;
    if (!name.startsWith(prefix)) continue;
    const key = name.slice(prefix.length);
    if (server.exposure.mode === "search" && isSearchModeTool(key)) return { kind: key, server };
    const entry = findTool(view, name);
    if (entry !== null && entry.server.name === server.name) return { kind: "tool", entry };
  }
  return null;
}

/** The tool a search-mode call names, by the name after the prefix or by the full name. */
export function findInServer(view: ServedView, server: ManifestServer, name: string): ServedTool | null {
  const full = name.startsWith(`${server.name}__`) ? name : `${server.name}__${name}`;
  const entry = findTool(view, full);
  return entry !== null && entry.server.name === server.name ? entry : null;
}
