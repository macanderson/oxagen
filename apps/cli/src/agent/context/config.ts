/**
 * Context-layer config — the `graph.*` settings that govern the code-graph
 * context path: whether it is on, where the GraphRAG backend lives, how large a
 * subgraph the `graph_query` tool may return, whether a graph miss may fall back
 * to grep, and which embedding backend powers the semantic half of the search.
 *
 * Values are read from `~/.config/oxagen/config.json` under a `graph` key and
 * layered over {@link DEFAULT_GRAPH_CONFIG}, so an unset field always falls back
 * to a sane default rather than `undefined`.
 */
import { readConfig } from "../../lib/config.js";
import {
  EMBED_PROVIDER_MODES,
  DEFAULT_GRAPH_CONFIG,
  type EmbedProviderMode,
  type GraphConfig,
  type GraphConfigPatch,
} from "./config-schema.js";

// The config SHAPE (modes, GraphConfig, defaults) lives in config-schema.ts —
// a leaf — because lib/config.ts composes it into CliConfig while this module
// reads it back through readConfig() from that same file (a type-level import
// cycle, until the shape moved out). Re-exported so consumers keep their path.
export {
  EMBED_PROVIDER_MODES,
  DEFAULT_GRAPH_CONFIG,
  type EmbedProviderMode,
  type GraphConfig,
  type GraphConfigPatch,
} from "./config-schema.js";

/** Accepted spellings that map onto a canonical {@link EmbedProviderMode}. */
const EMBED_PROVIDER_ALIASES: Record<string, EmbedProviderMode> = {
  local: "onnx",
};

/**
 * Parse a user-supplied provider-mode string (env var or config.json value).
 * Unknown/invalid input returns `undefined` rather than throwing — same
 * "invalid values fall back to the built-in policy" contract as the other
 * `OXAGEN_ROUTING_*` env vars, so a typo degrades safely instead of crashing
 * the CLI.
 */
export function parseEmbedProviderMode(
  raw: string | undefined | null,
): EmbedProviderMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized in EMBED_PROVIDER_ALIASES)
    return EMBED_PROVIDER_ALIASES[normalized];
  return (EMBED_PROVIDER_MODES as readonly string[]).includes(normalized)
    ? (normalized as EmbedProviderMode)
    : undefined;
}

/**
 * Coverage below this threshold counts as a graph *miss* and triggers the
 * logged fallback. `coverage` is 0..1 confidence the graph answered the query;
 * a genuinely-empty result is 0, and anything under this bar is too weak to
 * trust over a text scan. Kept here so the resolver and its tests agree on one
 * number.
 */
export const MIN_COVERAGE = 0.15;

/**
 * Resolve the effective graph config: user overrides from `config.json` layered
 * over {@link DEFAULT_GRAPH_CONFIG}, with env overrides for the master switch
 * (`OXAGEN_GRAPH_DISABLED=1` forces the fallback path for a whole shell) and the
 * embedding backend (`OXAGEN_EMBED_PROVIDER`, see {@link EmbedProviderMode}).
 * Pure over its `patch` argument so tests exercise the merge without the
 * filesystem.
 */
export function mergeGraphConfig(patch?: GraphConfigPatch): GraphConfig {
  const d = DEFAULT_GRAPH_CONFIG;
  const enabledEnv = process.env["OXAGEN_GRAPH_DISABLED"];
  const enabled =
    enabledEnv === "1" || enabledEnv === "true"
      ? false
      : (patch?.enabled ?? d.enabled);
  const embedProvider =
    parseEmbedProviderMode(process.env["OXAGEN_EMBED_PROVIDER"]) ??
    patch?.embedProvider ??
    d.embedProvider;
  return {
    enabled,
    endpoint: patch?.endpoint ?? d.endpoint,
    maxNodes: patch?.maxNodes ?? d.maxNodes,
    fallbackToGrep: patch?.fallbackToGrep ?? d.fallbackToGrep,
    embedProvider,
  };
}

/** The effective graph config for this process. */
export function readGraphConfig(): GraphConfig {
  return mergeGraphConfig(readConfig().graph);
}
