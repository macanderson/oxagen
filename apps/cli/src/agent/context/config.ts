/**
 * Context-layer config — the slice Group 3 owns (graph before grep).
 *
 * The unified `pipeline-config.json` is Group 6's single source of truth; each
 * earlier group ships the slice of config it owns and Group 6 merges them. This
 * module owns the `graph.*` settings that govern the code-graph context path:
 * whether it is on, where the GraphRAG backend lives, how large a subgraph the
 * `graph_query` tool may return, and whether a graph miss may fall back to grep.
 *
 * Values are read from `~/.config/oxagen/config.json` under a `graph` key and
 * layered over {@link DEFAULT_GRAPH_CONFIG}, so an unset field always falls back
 * to a sane default rather than `undefined`. Mirrors Group 7's
 * `contracts/config.ts` `GraphConfig`.
 */
import { readConfig } from "../../lib/config.js";

/** The context-layer config slice. Mirrors `contracts/config.ts` GraphConfig. */
export interface GraphConfig {
  /** Master switch. When false, the resolver goes straight to grep (logged). */
  enabled: boolean;
  /**
   * GraphRAG backend endpoint. The default port `0` is a sentinel meaning "no
   * remote backend" — the local tree-sitter code graph (DuckDB) is the backend.
   * A real `http(s)://` endpoint is honoured by future remote-backed builds.
   */
  endpoint: string;
  /** Upper bound on nodes in a returned subgraph — caps token cost per query. */
  maxNodes: number;
  /** When true, a graph miss falls back to grep/scan (logged); false fails closed. */
  fallbackToGrep: boolean;
}

/** A partial override written into `config.json` under `graph`. */
export type GraphConfigPatch = Partial<GraphConfig>;

/**
 * Coverage below this threshold counts as a graph *miss* and triggers the
 * logged fallback. `coverage` is 0..1 confidence the graph answered the query;
 * a genuinely-empty result is 0, and anything under this bar is too weak to
 * trust over a text scan. Kept here so the resolver and its tests agree on one
 * number.
 */
export const MIN_COVERAGE = 0.15;

/** Baked-in defaults. Mirrors `graph-tools.json -> config.graph`. */
export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  enabled: true,
  endpoint: "http://localhost:0/graphrag",
  maxNodes: 200,
  fallbackToGrep: true,
};

/**
 * Resolve the effective graph config: user overrides from `config.json` layered
 * over {@link DEFAULT_GRAPH_CONFIG}, with an env override for the master switch
 * (`OXAGEN_GRAPH_DISABLED=1` forces the fallback path for a whole shell). Pure
 * over its `patch` argument so tests exercise the merge without the filesystem.
 */
export function mergeGraphConfig(patch?: GraphConfigPatch): GraphConfig {
  const d = DEFAULT_GRAPH_CONFIG;
  const enabledEnv = process.env["OXAGEN_GRAPH_DISABLED"];
  const enabled = enabledEnv === "1" || enabledEnv === "true" ? false : patch?.enabled ?? d.enabled;
  return {
    enabled,
    endpoint: patch?.endpoint ?? d.endpoint,
    maxNodes: patch?.maxNodes ?? d.maxNodes,
    fallbackToGrep: patch?.fallbackToGrep ?? d.fallbackToGrep,
  };
}

/** The effective graph config for this process. */
export function readGraphConfig(): GraphConfig {
  return mergeGraphConfig(readConfig().graph);
}
