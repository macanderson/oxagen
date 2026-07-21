/**
 * CLI adapters for the `@oxagen/agent-engine` ports. Each implements one engine
 * port with local CLI resources (filesystem, local memory/code-graph) or the
 * platform REST surface (metered AI). See ADR-019.
 */
export { createCwdWorkspace, createGatedWorkspace } from "./workspace.js";
export {
  createCombinedMemory,
  createServerMemory,
  type ServerMemory,
  type ServerMemoryOptions,
  type CombinedMemoryOptions,
} from "./memory-provider.js";
export { createCodeGraphProvider } from "./code-graph-provider.js";
export {
  createPlatformAgentAi,
  type PlatformAgentAiOptions,
} from "./platform-agent-ai.js";
export {
  createGatewayAgentAi,
  gatewayReasoningOptions,
  type GatewayAgentAiOptions,
} from "./gateway-agent-ai.js";
export {
  prepareOnDeviceCoordinator,
  type OnDeviceCoordinator,
  type PrepareOnDeviceOptions,
} from "./on-device-agent-ai.js";
export {
  resolveCoordinatorAi,
  meteredCloudGenerate,
  type ResolvedCoordinator,
  type ResolveCoordinatorOptions,
} from "./coordinator.js";
