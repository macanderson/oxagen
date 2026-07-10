export * from "./runtime/materialize-tools";
export * from "./runtime/approval";
export * from "./runtime/stream-events";
export { isKnowledgeGraphEnabled } from "./runtime/knowledge-graph";
// Surface-bootstrap wiring for the Engram async backends (Inngest graph-sync +
// embed client, ClickHouse compile-telemetry sink). Call once at each server
// surface's boot so emitGraphSync/emitEmbedEvent/emitCompileTelemetry stop
// silently no-oping.
export { bootstrapEngramRuntime } from "./runtime/engram-bootstrap";
export * from "./dispatch/subagent";
export * from "./dispatch/mcp-client";
export * from "./memory/neo4j";
export * as hooks from "./hooks/runtime";
export { resolveHandler, invokeCapability } from "./handlers/index";
export type { CapabilityHandlerFn } from "./handlers/index";
// Typed subagent-fanout errors — surfaces (apps/api) import these to map an
// unknown / cross-tenant fanout id to a 404 instead of a 500 via instanceof,
// not a brittle error-message regex.
export {
  FanoutNotFoundError,
  isFanoutNotFoundError,
  SubagentRunNotFoundError,
  isSubagentRunNotFoundError,
  ExecutionNotFoundError,
  isExecutionNotFoundError,
} from "./handlers/subagent-errors";
export { buildChatSystemPrompt } from "./system-prompt";
export type { SystemPromptContext } from "./system-prompt";
// A2A skill-addressed routing (apps/api's A2A bridge resolves message.metadata.skillId
// against this before composing the per-task system prompt).
export { resolveAgentForA2A } from "./handlers/_agent-definition";
export type { AgentForA2A } from "./handlers/_agent-definition";
