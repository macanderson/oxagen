import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Oxagen Agent Schema — runtime-validated source of truth.
// ─────────────────────────────────────────────────────────────────────────────
// This module is the executable implementation of docs/reference/agent-schema.ts.
// An agent DEFINITION is the versioned, declarative source of truth (what the
// agent is, what it loads, how it reaches the graph, and whether it is
// deployed). Triggers belong to automations/playbooks, not the agent — a
// definition is a pure, portable unit with no trigger fields. An agent
// INSTANCE is one running execution of a definition with live state and a
// debug posture. An agent LOG is the append-only, typed traceability record
// for a run (persisted to ClickHouse).
//
// Naming aligns with the Vercel AI SDK and MCP: "tool" is the umbrella, and the
// plain inline-callable kind is "function" — a platform capability the agent is
// allowed to invoke through the kernel.
//
// ADR-041 removed the execution runtime, and with it every field that
// described HOW an agent runs: skills, sandboxes, sandbox-bound environments
// and code mode are gone. What remains is the governed-agent REGISTRY record —
// identity, versioned instructions, the graph scope it may reason over, and the
// allowlist of tools it may reach.
//
// The two escape hatches from the reference (`AgentTool.config` and
// `AgentLogEntry.data`) stay typed as open records: they are deliberate seams
// keyed off `type`, tightened to discriminated unions when hardening.
// ─────────────────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════
// GRAPH ACCESS — what the agent reads, how it grounds, and its budget
// ═════════════════════════════════════════════════════════════════════════════

/** Write posture against the ontology. Most agents are `read`; `extend` is
 *  granted deliberately to agents allowed to propose structure. */
export const graphAccessModeSchema = z.enum(["read", "extend"]);
export type GraphAccessMode = z.infer<typeof graphAccessModeSchema>;

/** Entry-node selection strategy:
 *  - `semantic`: embedding similarity against the query.
 *  - `lexical`: keyword/property match.
 *  - `hybrid`: both semantic and lexical, merged.
 *  - `explicit`: the caller supplies entry node ids directly. */
export const graphRetrievalStrategySchema = z.enum([
  "semantic",
  "lexical",
  "hybrid",
  "explicit",
]);
export type GraphRetrievalStrategy = z.infer<
  typeof graphRetrievalStrategySchema
>;

export const graphRetrievalSchema = z.object({
  /** How entry nodes are chosen before traversal begins. */
  strategy: graphRetrievalStrategySchema,
  /** Node/edge types the agent may traverse. Undefined/empty = all permitted
   *  types. Constraining this keeps an agent in its lane (a lane, not a budget). */
  scopeToTypes: z.array(z.string()).optional(),
});
export type GraphRetrieval = z.infer<typeof graphRetrievalSchema>;

export const graphBudgetSchema = z.object({
  /** Max hops from an entry node. Caps traversal breadth/depth. */
  maxHops: z.number().int().nonnegative(),
  /** Max nodes returned into context. Caps token spend. */
  maxNodes: z.number().int().positive(),
  /** Minimum relevance score (0–1) a node must clear to enter context. */
  minRelevance: z.number().min(0).max(1).optional(),
  /** Wall-clock ceiling on a single traversal, in ms. */
  maxTraversalMs: z.number().int().positive().optional(),
});
export type GraphBudget = z.infer<typeof graphBudgetSchema>;

export const graphAccessSchema = z.object({
  /** The ontology id this agent is bound to. Scopes every query; isolation seam. */
  ontologyId: z.string(),
  /** `extend` may propose new nodes/edges; `read` is query-only. Default `read`. */
  mode: graphAccessModeSchema.default("read"),
  /** How the agent grounds itself before traversing — picks entry nodes. */
  retrieval: graphRetrievalSchema,
  /** Bounds on any single context pull. */
  budget: graphBudgetSchema,
});
export type GraphAccess = z.infer<typeof graphAccessSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// AGENT TOOLS — the uniform "things an agent loads" model
// ═════════════════════════════════════════════════════════════════════════════

/** The two kinds of thing a governed agent may be granted.
 *  `function` = one platform capability, invoked through the kernel (so it
 *  carries the IAM / entitlement / metering gates with it);
 *  `mcp_server` = a registered MCP connection vending many tools, governed by
 *  the workspace's tool RBAC rules and consent ledger.
 *
 *  ADR-041 removed `skill` (skills are gone) and `agent` (subagent fan-out is
 *  gone). An allowlist entry names something the platform can actually gate. */
export const agentToolTypeSchema = z.enum(["function", "mcp_server"]);
export type AgentToolType = z.infer<typeof agentToolTypeSchema>;

export const agentToolSchema = z.object({
  /** Which kind of thing is loaded. Drives how `ref` and `config` are read. */
  type: agentToolTypeSchema,
  /** Reference to the granted thing: a capability name (`function`) or an MCP
   *  server public id (`mcp_server`). */
  ref: z.string(),
  /** Type-specific config, e.g. an MCP server's per-agent tool narrowing.
   *  SEAM: typed loosely; tighten to a discriminated union on `type` when
   *  hardening. */
  config: z.record(z.string(), z.unknown()).optional(),
});
export type AgentTool = z.infer<typeof agentToolSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// AGENT DEFINITION — the versioned, declarative source of truth
// ═════════════════════════════════════════════════════════════════════════════

/** Deploy posture, distinct from the draft/active/archived lifecycle. A new
 *  agent is always created `inactive`; activation makes it eligible to be
 *  triggered by an automation/playbook. */
export const agentDeploymentStatusSchema = z.enum(["inactive", "active"]);
export type AgentDeploymentStatus = z.infer<typeof agentDeploymentStatusSchema>;

export const agentDefinitionSchema = z.object({
  /** Stable id. Slugged public_id + UUID under the hood, per Oxagen convention. */
  id: z.string(),
  /** Human-readable name shown in selectors and the agents registry. */
  name: z.string().min(1),
  /** What this agent does — the description a human governs it by. */
  description: z.string(),
  /** Immutable version. Publish a new version; never edit one in place. */
  version: z.string(),
  /** The ontology this agent reasons over and how it pulls context efficiently. */
  graph: graphAccessSchema,
  /** The tool allowlist: the capabilities and MCP servers this agent may
   *  reach. One uniform list, and the ceiling the runtime materializes against
   *  — a tool absent from it is never advertised to the model. */
  agentTools: z.array(agentToolSchema),
  /** Optional system prompt / instructions baked into the definition. */
  instructions: z.string().optional(),
  /** Deploy posture. New definitions seed `inactive`. */
  deploymentStatus: agentDeploymentStatusSchema.default("inactive"),
  /** Tenant + workspace scope. Every agent is scoped; no global agents. */
  tenantId: z.string(),
  workspaceId: z.string().optional(),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

/** The portion of an AgentDefinition persisted in `agent_versions.config` — the
 *  versioned body, without the identity columns the `agents`/`agent_versions`
 *  rows already carry. Keeping these in one schema means the row and the jsonb
 *  never drift. */
export const agentDefinitionConfigSchema = agentDefinitionSchema.pick({
  graph: true,
  agentTools: true,
  instructions: true,
});
export type AgentDefinitionConfig = z.infer<typeof agentDefinitionConfigSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// DEBUG — a per-run verbosity setting, not a property of the definition
// ═════════════════════════════════════════════════════════════════════════════

export const debugOptionsSchema = z.object({
  /** Master switch. When false, only standard lifecycle/info entries log. */
  enabled: z.boolean().default(false),
  /** Capture every graph query (query + params + nodes returned). */
  traceGraphQueries: z.boolean().optional(),
  /** Capture full tool inputs and outputs, not just that a tool was called. */
  traceToolIO: z.boolean().optional(),
  /** Capture intermediate reasoning/thinking tokens. */
  traceReasoning: z.boolean().optional(),
  /** Snapshot the assembled context window per step. Heavy; investigation only. */
  captureContext: z.boolean().optional(),
});
export type DebugOptions = z.infer<typeof debugOptionsSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// AGENT INSTANCE — one execution of a definition, with live state and debug
// ═════════════════════════════════════════════════════════════════════════════

/** Lifecycle status of a single run. `interrupted` covers a human-in-the-loop
 *  or approval pause; `errored` is a terminal failure. */
export const agentRunStatusSchema = z.enum([
  "pending",
  "running",
  "interrupted",
  "completed",
  "errored",
]);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentInstanceSchema = z.object({
  /** This run's id. */
  runId: z.string(),
  /** The definition (by id + version) this instance executes. */
  definitionId: z.string(),
  definitionVersion: z.string(),
  /** The run that caused this one, when there is one (e.g. a scheduled
   *  re-run). Undefined for a top-level run. Audit, cost attribution and the
   *  distributed trace all fall out of run lineage. */
  parentRunId: z.string().optional(),
  /** Run lifecycle status. */
  status: agentRunStatusSchema,
  /** Per-run debug posture. Controls log verbosity, not whether logging happens. */
  debug: debugOptionsSchema,
  /** Live thread state for this run. */
  state: z.record(z.string(), z.unknown()),
  /** When the run started and (once finished) ended. */
  startedAt: z.string(),
  endedAt: z.string().optional(),
});
export type AgentInstance = z.infer<typeof agentInstanceSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// AGENT LOG — append-only, typed traceability record for a run
// ═════════════════════════════════════════════════════════════════════════════
// The log is ALWAYS on at info+ level — the baseline audit trail. DebugOptions
// does not enable logging; it raises verbosity, promoting debug-level detail
// into the same stream. One log per run, keyed by runId.

/** The kind of event an entry records. Drives the shape of `AgentLogEntry.data`. */
export const agentLogEntryTypeSchema = z.enum([
  "lifecycle", // run started, finished, errored, interrupted
  "decision", // the agent chose a path / selected a tool
  "graph_query", // a read/traversal against the ontology
  "graph_write", // a proposed/committed node or edge (extend mode)
  "tool_call", // an AgentTool invocation (capability or MCP tool)
  "memory", // a memory read or write
  "error", // a recoverable or terminal failure
]);
export type AgentLogEntryType = z.infer<typeof agentLogEntryTypeSchema>;

/** Standard severity levels for filtering. `debug` entries appear only when the
 *  run's DebugOptions promote them into the stream. */
export const agentLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type AgentLogLevel = z.infer<typeof agentLogLevelSchema>;

export const agentLogEntrySchema = z.object({
  /** Entry id, monotonic within the run so ordering is unambiguous. */
  id: z.string(),
  /** The run this entry belongs to. Keys back to AgentInstance.runId. */
  runId: z.string(),
  /** When it happened. */
  timestamp: z.string(),
  /** What kind of thing happened — drives the shape of `data`. */
  type: agentLogEntryTypeSchema,
  /** Severity, mirroring standard log levels for filtering. */
  level: agentLogLevelSchema,
  /** One-line human summary, always present. */
  message: z.string(),
  /** Type-specific structured payload, shaped by `type`. SEAM: typed loosely;
   *  tighten to a discriminated union on `type` when hardening. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type AgentLogEntry = z.infer<typeof agentLogEntrySchema>;

export const agentLogSchema = z.object({
  /** Log id. */
  id: z.string(),
  /** The run this log records. Keys back to AgentInstance.runId. */
  runId: z.string(),
  /** Definition that produced the run, denormalized for log-only queries. */
  definitionId: z.string(),
  definitionVersion: z.string(),
  /** Tenant + workspace scope, denormalized so logs are queryable in isolation. */
  tenantId: z.string(),
  workspaceId: z.string().optional(),
  /** The ordered entries. Append-only; never mutated or deleted in place. */
  entries: z.array(agentLogEntrySchema),
  /** When the log opened and (once the run ends) closed. */
  startedAt: z.string(),
  endedAt: z.string().optional(),
});
export type AgentLog = z.infer<typeof agentLogSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// PARSERS — the single seam other layers use to validate persisted definitions
// ═════════════════════════════════════════════════════════════════════════════

/** Parse an `agent_versions.config` jsonb blob into a typed, validated config.
 *  Handlers and the runtime call this instead of trusting the column shape. */
export function parseAgentDefinitionConfig(
  value: unknown,
): AgentDefinitionConfig {
  return agentDefinitionConfigSchema.parse(value);
}

/** Parse a full AgentDefinition (identity + config). Used by the seeder and the
 *  definition CRUD handlers when assembling a definition from row + config. */
export function parseAgentDefinition(value: unknown): AgentDefinition {
  return agentDefinitionSchema.parse(value);
}
