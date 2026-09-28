// list.ts: the tools/list entries a run is served (lane M15; mcp-studio-spec,
// Call path, step 1, and Large servers).
//
// A direct-mode server lists each served tool's effective definition. A
// search-mode server lists its search, describe, and call, and only when it
// serves at least one tool. The annotations come from the classification,
// never from the upstream server.
import { effectiveAnnotations, type EffectiveDefinition, type ManifestServer } from "@oxagen/mcp-studio";
import { visibleTools, type ServedTool, type ServedView } from "./snapshot";

function definitionOf({ tool }: ServedTool): EffectiveDefinition {
  return { ...tool.definition, annotations: effectiveAnnotations(tool.classification) };
}

/**
 * The search-mode trio. call's hints hold when any tool it can reach holds
 * them, counted over the tools this agent is served.
 */
function searchDefinitions(server: ManifestServer, served: readonly ServedTool[]): EffectiveDefinition[] {
  const hints = served.map(({ tool }) => effectiveAnnotations(tool.classification));
  const destructive = hints.some((hint) => hint.destructiveHint);
  const openWorld = hints.some((hint) => hint.openWorldHint);
  return (server.search ?? []).map((definition) =>
    definition.name === `${server.name}__call`
      ? { ...definition, annotations: { readOnlyHint: false, destructiveHint: destructive, openWorldHint: openWorld } }
      : definition,
  );
}

/** The run's tools/list entries, ordered by server name, then by tool name. */
export function listServed(view: ServedView): EffectiveDefinition[] {
  const byServer = new Map<string, ServedTool[]>();
  for (const entry of visibleTools(view)) {
    const list = byServer.get(entry.server.name);
    if (list === undefined) byServer.set(entry.server.name, [entry]);
    else list.push(entry);
  }
  const out: EffectiveDefinition[] = [];
  for (const [, served] of byServer) {
    const server = served[0]?.server;
    if (server === undefined) continue;
    if (server.exposure.mode === "search") out.push(...searchDefinitions(server, served));
    else out.push(...served.map(definitionOf));
  }
  return out;
}
