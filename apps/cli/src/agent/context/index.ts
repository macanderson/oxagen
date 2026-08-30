/**
 * The context layer (graph before grep).
 *
 * Public surface: the resolver a caller injects, the `graph_query` core,
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
  parseEmbedProviderMode,
  EMBED_PROVIDER_MODES,
  type GraphConfig,
  type GraphConfigPatch,
  type EmbedProviderMode,
} from "./config.js";
export {
  resolveEmbeddingClient,
  GatewayEmbeddingClient,
  GATEWAY_PROVIDER_ID,
  type EmbeddingClient,
  type ResolveEmbeddingClientDeps,
} from "./embedding.js";
export {
  OllamaEmbeddingClient,
  createOllamaEmbeddingClient,
  probeOllama,
  OLLAMA_PROVIDER_PREFIX,
} from "./embedding-ollama.js";
export {
  createOnnxEmbeddingClient,
  isOnnxAvailable,
  ONNX_PROVIDER_PREFIX,
} from "./embedding-onnx.js";
export {
  formatGraphResultJson,
  formatGraphContextForPrompt,
} from "./format.js";
export { grepFallback } from "./grep-fallback.js";
