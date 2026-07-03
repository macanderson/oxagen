/**
 * Context-layer config — the slice Group 3 owns (graph before grep).
 *
 * The unified `pipeline-config.json` is Group 6's single source of truth; each
 * earlier group ships the slice of config it owns and Group 6 merges them. This
 * module owns the `graph.*` settings that govern the code-graph context path:
 * whether it is on, where the GraphRAG backend lives, how large a subgraph the
 * `graph_query` tool may return, whether a graph miss may fall back to grep, and
 * which embedding backend powers the semantic half of `semantic_search`.
 *
 * Values are read from `~/.config/oxagen/config.json` under a `graph` key and
 * layered over {@link DEFAULT_GRAPH_CONFIG}, so an unset field always falls back
 * to a sane default rather than `undefined`. Mirrors Group 7's
 * `contracts/config.ts` `GraphConfig`.
 */
import { readConfig } from "../../lib/config.js";

/**
 * Which backend `resolveEmbeddingClient` (embedding.ts) uses:
 *   - `auto`    (default) — Ollama if reachable → local ONNX if installed →
 *               the platform gateway if a key is configured → null (lexical
 *               degrade). Zero-config: tries the free/local/offline options
 *               first.
 *   - `ollama`  — local Ollama server only (see embedding-ollama.ts).
 *   - `onnx`    — in-process ONNX model via `fastembed` only (see
 *               embedding-onnx.ts). `local` is accepted as an alias.
 *   - `gateway` — the platform's Vercel AI Gateway model only (the original,
 *               pre-local-embeddings behaviour).
 *   - `off`     — no embedding client at all; `semantic_search` degrades to a
 *               plain miss and `graph_query` runs structural-only.
 */
export const EMBED_PROVIDER_MODES = ["auto", "ollama", "onnx", "gateway", "off"] as const;
export type EmbedProviderMode = (typeof EMBED_PROVIDER_MODES)[number];

/** Accepted spellings that map onto a canonical {@link EmbedProviderMode}. */
const EMBED_PROVIDER_ALIASES: Record<string, EmbedProviderMode> = { local: "onnx" };

/**
 * Parse a user-supplied provider-mode string (env var or config.json value).
 * Unknown/invalid input returns `undefined` rather than throwing — same
 * "invalid values fall back to the built-in policy" contract as the other
 * `OXAGEN_ROUTING_*` env vars, so a typo degrades safely instead of crashing
 * the CLI.
 */
export function parseEmbedProviderMode(raw: string | undefined | null): EmbedProviderMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized in EMBED_PROVIDER_ALIASES) return EMBED_PROVIDER_ALIASES[normalized];
  return (EMBED_PROVIDER_MODES as readonly string[]).includes(normalized)
    ? (normalized as EmbedProviderMode)
    : undefined;
}

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
  /** Which embedding backend powers `semantic_search`. See {@link EmbedProviderMode}. */
  embedProvider: EmbedProviderMode;
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
  embedProvider: "auto",
};

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
  const enabled = enabledEnv === "1" || enabledEnv === "true" ? false : patch?.enabled ?? d.enabled;
  const embedProvider =
    parseEmbedProviderMode(process.env["OXAGEN_EMBED_PROVIDER"]) ?? patch?.embedProvider ?? d.embedProvider;
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
