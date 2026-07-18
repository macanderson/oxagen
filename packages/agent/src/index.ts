export * from "./runtime/materialize-tools";
export * from "./runtime/approval";
export * from "./runtime/stream-events";
// The platform TurnDriver — agent-engine v2 Phase 2 integration
// (docs/specs/agent-engine-v2/plan.md). Consumed by @oxagen/agent-worker's
// main.ts to wire createAgentWorker; see the module doc for the RunSpec v1
// contract and this v1 driver's explicit limitations.
export {
  createPlatformTurnDriver,
  parseRunSpec,
  type ClaimedRun,
  type RunEventRecord,
  type TurnDriver,
  type RunSpecV1,
} from "./runtime/turn-driver";
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
// Sandbox session lifecycle & work-recovery (spec: sandbox-session-lifecycle).
// The reaper (packages/inngest-functions) and the recover_sandbox_session
// capability both drive these; exported here as the public lifecycle surface.
export {
  releaseSession,
  sandboxGraceSeconds,
  sandboxStaleRunningSeconds,
  markSessionStatus,
  getSessionByPublicId,
} from "./handlers/_sandbox-session";
export {
  recoverSandboxSession,
  recoveryLabel,
} from "./handlers/recover-sandbox-session";
export type {
  RecoveryOutcome,
  RecoveryKind,
} from "./handlers/recover-sandbox-session";
export { agentSandboxStopHandler } from "./handlers/agent.sandbox.stop";
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
