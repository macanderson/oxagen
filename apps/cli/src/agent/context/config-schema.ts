/**
 * config-schema.ts — the graph config SHAPE, as a dependency-free leaf.
 *
 * lib/config.ts composes this slice into the whole-CLI `CliConfig` shape while
 * the accessors next door (config.ts) read it back through `readConfig()` from
 * that same lib/config.ts — so the shape must live in a leaf neither side owns,
 * or the two files form an import cycle (they did, until this extraction).
 */

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
export const EMBED_PROVIDER_MODES = [
  "auto",
  "ollama",
  "onnx",
  "gateway",
  "off",
] as const;
export type EmbedProviderMode = (typeof EMBED_PROVIDER_MODES)[number];

/** The context-layer config slice. */
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

/** Baked-in defaults. */
export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  enabled: true,
  endpoint: "http://localhost:0/graphrag",
  maxNodes: 200,
  fallbackToGrep: true,
  embedProvider: "auto",
};
