/**
 * Group 3 — the context layer (graph before grep).
 *
 * Public surface: the resolver the orchestrator injects, the `graph_query` core,
 * the config slice, and the prompt/JSON formatters. Everything else in this
 * directory is an implementation detail.
 */
export {
  GraphContextResolver,
  createContextResolver,
  type GraphContextResolverDeps,
  type GraphQueryInput,
  type GraphResult,
  type GraphLogEvent,
  type GraphLogFn,
} from "./context-resolver.js";
export {
  runGraphQuery,
  type GraphQueryOptions,
  type GraphContextResult,
  type ImpactedFileRef,
  type GraphSymbolRef,
  type GraphEdgeRef,
} from "./graph-query.js";
export {
  DEFAULT_GRAPH_CONFIG,
  MIN_COVERAGE,
  mergeGraphConfig,
  readGraphConfig,
  type GraphConfig,
  type GraphConfigPatch,
} from "./config.js";
export {
  resolveEmbeddingClient,
  GatewayEmbeddingClient,
  GATEWAY_PROVIDER_ID,
  type EmbeddingClient,
} from "./embedding.js";
export { formatGraphResultJson, formatGraphContextForPrompt } from "./format.js";
export { grepFallback } from "./grep-fallback.js";
