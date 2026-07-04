export * from "./runtime/materialize-tools";
export * from "./runtime/approval";
export * from "./runtime/stream-events";
export { isKnowledgeGraphEnabled } from "./runtime/knowledge-graph";
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
