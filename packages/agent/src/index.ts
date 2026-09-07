/**
 * `@oxagen/agent` — the governed-agent runtime library.
 *
 * Oxagen governs agents; it does not run them (ADR-041). What survives here is
 * the machinery that makes a governed turn possible and auditable:
 *
 *   1. `runtime/` — materialising capability contracts and registered MCP
 *      servers into AI-SDK tools, with IAM → entitlement → tool RBAC →
 *      consent → approval → telemetry applied per call.
 *   2. `handlers/` — the surviving `agent.*` capability handlers: approvals,
 *      the MCP registry and its consent ledger, agent memory, the agent
 *      definition registry and its RBAC roles, the execution record, traces,
 *      and error clustering.
 *   3. `dispatch/` — the MCP client, and the Neo4j projection of the tools an
 *      execution invoked.
 *
 * There is no sandbox, no coding engine, no worker, no subagent fan-out and no
 * background-task machinery behind any of it.
 */

// Tool materialization — the one seam where a capability contract or an
// external MCP tool becomes something a model may call, and the one place the
// per-call governance gates are applied.
export * from "./runtime/materialize-tools";
// The ontology read set — the graph capabilities an agent reasons over, plus
// the read-only guard and the per-run allowlist union that carries them into a
// narrowed run. A surface that wants to grant the graph names this set rather
// than spelling eight capability names of its own.
export * from "./runtime/ontology-tools";
export * from "./runtime/approval";
export * from "./runtime/stream-events";
export { isKnowledgeGraphEnabled } from "./runtime/knowledge-graph";
export * from "./dispatch/mcp-client";
export * from "./dispatch/tool-projection";
export * from "./memory/neo4j";
export { resolveHandler, invokeCapability } from "./handlers/index";
export type { CapabilityHandlerFn } from "./handlers/index";
// Typed execution-lookup error — surfaces (apps/api) import these to map an
// unknown / cross-tenant execution id to a 404 instead of a 500 via
// instanceof, not a brittle error-message regex.
export {
  ExecutionNotFoundError,
  isExecutionNotFoundError,
} from "./handlers/execution-errors";
// The governance agent's system prompt (no coding, no shell, no sandbox).
export { buildChatSystemPrompt } from "./system-prompt";
export type { SystemPromptContext } from "./system-prompt";
