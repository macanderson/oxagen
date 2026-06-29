/**
 * CLI adapters for the `@oxagen/agent-engine` ports. Each implements one engine
 * port with local CLI resources (filesystem, local memory/code-graph) or the
 * platform REST surface (code-map, graph-sync, metered AI). See ADR-019.
 */
export { createCwdWorkspace } from "./workspace.js";
export { createMemoryProvider, type CliMemoryOptions } from "./memory-provider.js";
export { createCodeGraphProvider } from "./code-graph-provider.js";
export { createCodeMapProvider, type CodeMapApiOptions } from "./code-map-provider.js";
export { createGraphSyncProvider, type GraphSyncOptions } from "./graph-sync-provider.js";
export {
  createPlatformAgentAi,
  type PlatformAgentAiOptions,
} from "./platform-agent-ai.js";
