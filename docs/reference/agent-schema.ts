// ─────────────────────────────────────────────────────────────────────────────
// Oxagen Agent Schema
// ─────────────────────────────────────────────────────────────────────────────
// An agent DEFINITION is the versioned, declarative source of truth: what the
// agent is, what it loads, and how it reaches the graph. An agent INSTANCE is one
// running execution of a definition with live state and a debug posture. An agent
// LOG is the append-only, typed traceability record for a run.
//
// Naming aligns with the Vercel AI SDK and MCP: "tool" is the umbrella, and the
// plain inline-callable kind is "function". A subagent is just an AgentTool of
// type "agent" — A2A and subagents reuse the same loading model, no separate
// protocol. Every type referenced below is defined in this file; nothing is left
// open. The two intentional escape hatches (`config` and log `data`) are typed as
// Record<string, unknown> and flagged for later tightening into discriminated
// unions — that is a deliberate seam, not an undefined type.
// ─────────────────────────────────────────────────────────────────────────────


// ═════════════════════════════════════════════════════════════════════════════
// 1. AGENT DEFINITION — the versioned, declarative source of truth
// ═════════════════════════════════════════════════════════════════════════════

export interface AgentDefinition {
  /** Stable id. Slugged public_id + UUID under the hood, per Oxagen convention. */
  id: string
  /** Human-readable name shown in selectors and A2A routing. */
  name: string
  /** What this agent does — drives routing and subagent selection. */
  description: string
  /** Immutable version. Publish a new version; never edit a definition in place. */
  version: string

  /** The ontology this agent reasons over and how it pulls context efficiently. */
  graph: GraphAccess

  /** Everything the agent loads: functions, MCP servers, skills, and subagents.
   *  One uniform list so a subagent loads the same way as an MCP server. */
  agentTools: AgentTool[]

  /** Optional system prompt / instructions baked into the definition. */
  instructions?: string

  /** Tenant + workspace scope. Every agent is scoped; no global agents. */
  tenantId: string
  workspaceId?: string
}


// ═════════════════════════════════════════════════════════════════════════════
// 2. GRAPH ACCESS — what the agent reads, how it grounds, and its budget
// ═════════════════════════════════════════════════════════════════════════════

export interface GraphAccess {
  /** The ontology id this agent is bound to. Scopes every query; isolation seam. */
  ontologyId: string
  /** `extend` may propose new nodes/edges; `read` is query-only. Default to `read`. */
  mode: GraphAccessMode
  /** How the agent grounds itself before traversing — picks entry nodes. */
  retrieval: GraphRetrieval
  /** Bounds on any single context pull. A subagent inherits this and may narrow
   *  it, never widen it. */
  budget: GraphBudget
}

/** Write posture against the ontology. Most agents are `read`; `extend` is granted
 *  deliberately to agents allowed to propose structure. */
export type GraphAccessMode = "read" | "extend"

export interface GraphRetrieval {
  /** How entry nodes are chosen before traversal begins. */
  strategy: GraphRetrievalStrategy
  /** Node/edge types the agent may traverse. Undefined/empty = all permitted types.
   *  Constraining this keeps an agent in its lane (e.g. a billing agent never walks
   *  into HR nodes even if an edge connects them). A lane, not a budget. */
  scopeToTypes?: string[]
}

/** Entry-node selection strategy:
 *  - `semantic`: embedding similarity against the query.
 *  - `lexical`: keyword/property match.
 *  - `hybrid`: both semantic and lexical, merged.
 *  - `explicit`: the caller supplies entry node ids directly. */
export type GraphRetrievalStrategy = "semantic" | "lexical" | "hybrid" | "explicit"

export interface GraphBudget {
  /** Max hops from an entry node. Caps traversal breadth/depth. */
  maxHops: number
  /** Max nodes returned into context. Caps token spend. */
  maxNodes: number
  /** Minimum relevance score (0–1) a node must clear to enter context. Cuts the
   *  long tail of weakly-related nodes that pass the hop test but add noise. */
  minRelevance?: number
  /** Wall-clock ceiling on a single traversal, in ms. Backstop against expensive
   *  walks over dense regions even when the result set is small. */
  maxTraversalMs?: number
}


// ═════════════════════════════════════════════════════════════════════════════
// 3. AGENT TOOLS — the uniform "things an agent loads" model
// ═════════════════════════════════════════════════════════════════════════════

/** `function` = inline callable; `mcp_server` = connection vending many tools;
 *  `skill` = a loaded skill; `agent` = a subagent (A2A). */
export type AgentToolType = "function" | "mcp_server" | "skill" | "agent"

export interface AgentTool {
  /** Which kind of thing is loaded. Drives how `ref` and `config` are interpreted. */
  type: AgentToolType
  /** Reference to the loaded thing: a function name, MCP server url/id, skill id,
   *  or agent id. */
  ref: string
  /** Type-specific config: MCP auth, skill params, subagent budget overrides, etc.
   *  SEAM: typed loosely now; tighten to a discriminated union on `type` (Zod-backed)
   *  when hardening, so `function` config and `agent` config validate differently. */
  config?: Record<string, unknown>
}


// ═════════════════════════════════════════════════════════════════════════════
// 4. AGENT INSTANCE — one execution of a definition, with live state and debug
// ═════════════════════════════════════════════════════════════════════════════

export interface AgentInstance {
  /** This run's id. */
  runId: string
  /** The definition (by id + version) this instance executes. */
  definitionId: string
  definitionVersion: string
  /** Who called it. Undefined for a top-level run, set for a subagent invocation.
   *  parentRunId gives the call tree for free — audit, cost attribution, and the
   *  distributed trace all fall out of run lineage. */
  parentRunId?: string
  /** Run lifecycle status. */
  status: AgentRunStatus
  /** Per-run debug posture. Controls log verbosity, not whether logging happens. */
  debug: DebugOptions
  /** Live thread state for this run. */
  state: Record<string, unknown>
  /** When the run started and (once finished) ended. */
  startedAt: string
  endedAt?: string
}

/** Lifecycle status of a single run. `interrupted` covers a human-in-the-loop or
 *  approval pause; `errored` is a terminal failure. */
export type AgentRunStatus =
  | "pending"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"


// ═════════════════════════════════════════════════════════════════════════════
// 5. DEBUG — a per-run verbosity setting, not a property of the definition
// ═════════════════════════════════════════════════════════════════════════════

export interface DebugOptions {
  /** Master switch. When false, only standard lifecycle/info entries are logged. */
  enabled: boolean
  /** Capture every graph query (query + params + nodes returned). Verbose at scale. */
  traceGraphQueries?: boolean
  /** Capture full tool inputs and outputs, not just that a tool was called. */
  traceToolIO?: boolean
  /** Capture intermediate reasoning/thinking tokens. */
  traceReasoning?: boolean
  /** Snapshot the assembled context window per step. Heavy; investigation only. */
  captureContext?: boolean
}


// ═════════════════════════════════════════════════════════════════════════════
// 6. AGENT LOG — append-only, typed traceability record for a run
// ═════════════════════════════════════════════════════════════════════════════
// The log is ALWAYS on at info+ level — the baseline audit trail. DebugOptions
// does not enable logging; it raises verbosity, promoting debug-level detail into
// the same stream. One log per run, keyed by runId; subagent entries link to child
// runs so the full A2A call tree is reconstructable.

export interface AgentLog {
  /** Log id. */
  id: string
  /** The run this log records. Keys back to AgentInstance.runId. */
  runId: string
  /** Definition that produced the run, denormalized for log-only queries. */
  definitionId: string
  definitionVersion: string
  /** Tenant + workspace scope, denormalized so logs are queryable in isolation
   *  without joining back to the definition. */
  tenantId: string
  workspaceId?: string
  /** The ordered entries. Append-only; never mutated or deleted in place. */
  entries: AgentLogEntry[]
  /** When the log opened and (once the run ends) closed. */
  startedAt: string
  endedAt?: string
}

export interface AgentLogEntry {
  /** Entry id, monotonic within the run so ordering is unambiguous. */
  id: string
  /** The run this entry belongs to. Keys back to AgentInstance.runId. */
  runId: string
  /** When it happened. */
  timestamp: string
  /** What kind of thing happened — drives the shape of `data`. */
  type: AgentLogEntryType
  /** Severity, mirroring standard log levels for filtering. */
  level: AgentLogLevel
  /** One-line human summary, always present. */
  message: string
  /** Type-specific structured payload, shaped by `type`:
   *  - `graph_query`/`graph_write`: query + params + node/edge count (+ rows in debug).
   *  - `tool_call`: tool ref + (in debug) inputs/outputs.
   *  - `subagent_call`: the child runId, linking this entry to the subagent's log.
   *  - `memory`: nodeRef + weight + kind.
   *  - `decision`: the option chosen and the candidates considered.
   *  - `error`: error code + (in debug) stack.
   *  SEAM: typed loosely now; tighten to a discriminated union on `type` when
   *  hardening, so each entry kind validates its own payload shape. */
  data?: Record<string, unknown>
}

/** The kind of event an entry records. Drives the shape of `AgentLogEntry.data`. */
export type AgentLogEntryType =
  | "lifecycle"      // run started, finished, errored, interrupted
  | "decision"       // the agent chose a path / selected a tool
  | "graph_query"    // a read/traversal against the ontology
  | "graph_write"    // a proposed/committed node or edge (extend mode)
  | "tool_call"      // an AgentTool invocation (function/mcp/skill)
  | "subagent_call"  // delegation to a subagent (A2A)
  | "memory"         // a memory read or write
  | "error"          // a recoverable or terminal failure

/** Standard severity levels for filtering. `debug` entries appear only when the
 *  run's DebugOptions promote them into the stream. */
export type AgentLogLevel = "debug" | "info" | "warn" | "error"
