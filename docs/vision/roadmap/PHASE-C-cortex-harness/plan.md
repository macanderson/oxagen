# Phase C: Cortex Agent Harness (CLI Evolution)

> Evolve `apps/cli` from a thin API client into a persistent, context-daemon-backed
> agent harness. The CLI becomes the proof-of-concept that validates the full Engram
> engine in a developer-facing workflow.

---

## Overview

Phase C transforms the existing CLI (`apps/cli` — 134 commands, Commander + Ink TUI) into the Cortex agent harness. The key additions: a persistent context daemon that maintains warm indexes (no per-session rebuild), an incremental code graph maintained on file-watch, event-sourced sessions that enable fork/replay/time-travel, and structured tool I/O that indexes results instead of pasting raw text.

After this phase, the CLI starts instantly (daemon is warm), understands the codebase structurally (code graph, not grep), produces deterministic/replayable sessions, and shows token budget telemetry in the TUI.

---

## Prerequisites

- **Phase B complete**: `compile()` function working, integrated into agent runtime
- Context compiler produces valid windows from episodic + semantic + graph stores
- Retrieval engines operational with acceptable latency (< 50ms p99)
- `apps/cli` codebase stable (Commander + Ink, existing command structure)
- Tree-sitter parser infrastructure exists in `packages/ingestion/src/parsers/`

---

## Parallel Tracks

### Track 1: Context Daemon (Agent 1)

**Goal**: Build a persistent local service that maintains warm Engram indexes, code graph state, and session state across CLI invocations.

**Deliverables**:
- `apps/cli/src/daemon/server.ts` — Local daemon process (Unix socket or TCP)
- `apps/cli/src/daemon/client.ts` — Client library for CLI commands to talk to daemon
- `apps/cli/src/daemon/lifecycle.ts` — Start/stop/health check/auto-restart
- `apps/cli/src/daemon/state.ts` — Persistent state management (warm indexes)
- `apps/cli/src/daemon/watcher.ts` — File system watcher integration

**Architecture**:

```
┌─────────────────┐         Unix Socket         ┌──────────────────────────┐
│  CLI Process    │◄───────────────────────────►│   Context Daemon         │
│  (short-lived)  │                              │   (long-running)         │
│                 │  compile(), query(), recall() │                          │
│  Commander +    │                              │  ┌─────────────────────┐ │
│  Ink TUI        │                              │  │  Engram Engine      │ │
│                 │                              │  │  (warm indexes)     │ │
└─────────────────┘                              │  └─────────────────────┘ │
                                                 │  ┌─────────────────────┐ │
                                                 │  │  Code Graph         │ │
                                                 │  │  (file-watch)       │ │
                                                 │  └─────────────────────┘ │
                                                 │  ┌─────────────────────┐ │
                                                 │  │  Session State      │ │
                                                 │  │  (event log)        │ │
                                                 │  └─────────────────────┘ │
                                                 └──────────────────────────┘
```

**Daemon protocol** (JSON-RPC over Unix socket):

```typescript
// apps/cli/src/daemon/protocol.ts

export type DaemonRequest =
  | { method: "compile"; params: { taskFrame: TaskFrame; budget: TokenBudget } }
  | { method: "query"; params: { cxl: string } }
  | { method: "recall"; params: { handle: string } }
  | { method: "remember"; params: { event: EpisodicBody; opts: WriteOpts } }
  | { method: "session.fork"; params: { sessionId: string } }
  | { method: "session.replay"; params: { sessionId: string; at: number } }
  | { method: "graph.query"; params: { query: GraphQuery } }
  | { method: "health"; params: {} }
  | { method: "shutdown"; params: {} }
  ;

export type DaemonResponse = {
  result?: unknown;
  error?: { code: number; message: string };
};
```

**Lifecycle**:
- Daemon starts automatically on first CLI command (if not running)
- Health check: CLI pings daemon before each operation; restart if unhealthy
- Graceful shutdown on explicit `cortex daemon stop` command
- Auto-stop after 30 minutes of inactivity (configurable)
- PID file at `~/.oxagen/daemon.pid`, socket at `~/.oxagen/daemon.sock`
- Logs at `~/.oxagen/daemon.log` (rotated)

**State persistence**:
- DuckDB database at `~/.oxagen/engram.db` (project-scoped: `.oxagen/engram.db` in workspace)
- Code graph stored as adjacency lists in the DuckDB instance
- Session event logs stored in DuckDB episodic tables
- Vector index warmed into RAM on daemon start from DuckDB

**Tests**:
- Daemon starts and responds to health check within 500ms
- CLI command works with daemon (happy path)
- CLI command works without daemon (fallback: inline Engram)
- Daemon auto-restarts on crash
- Daemon respects PID file (no duplicate instances)

**Estimated effort**: 8–10 days

---

### Track 2: Incremental Code Graph (Agent 2)

**Goal**: Build and maintain a code graph (files, symbols, call sites, imports) incrementally on file-watch, not per-session.

**Deliverables**:
- `apps/cli/src/daemon/code-graph/builder.ts` — Initial graph build from workspace
- `apps/cli/src/daemon/code-graph/watcher.ts` — File-watch incremental updates
- `apps/cli/src/daemon/code-graph/query.ts` — Graph queries ("who calls X", "what imports Y")
- `apps/cli/src/daemon/code-graph/types.ts` — Node/edge types for code entities
- `packages/engram/src/retrieval/code-graph.ts` — Code graph as a retrieval engine for `compile()`

**Code graph entities**:

```typescript
// apps/cli/src/daemon/code-graph/types.ts

export type CodeNodeKind = "file" | "function" | "class" | "method" | "variable" | "import" | "export" | "type" | "interface";

export interface CodeNode {
  id: string;              // Content-addressed: blake3(path + name + kind)
  kind: CodeNodeKind;
  name: string;
  path: string;            // File path relative to workspace root
  range: { start: number; end: number };  // Line range
  language: string;
  signature?: string;      // Function/method signature
  docstring?: string;      // JSDoc/docstring if present
}

export interface CodeEdge {
  source: string;          // CodeNode ID
  target: string;          // CodeNode ID
  type: "calls" | "imports" | "exports" | "extends" | "implements" | "contains" | "references";
}
```

**Build process**:
1. Walk workspace files (respecting `.gitignore`)
2. Parse each file with tree-sitter (reuse parsers from `packages/ingestion/src/parsers/`)
3. Extract symbols, imports, exports, call sites
4. Build in-memory adjacency graph
5. Persist to DuckDB for cross-session survival
6. Compute embeddings for each symbol (batch, async)

**Incremental updates**:
- `chokidar` (or native `fs.watch`) monitors workspace
- On file change: re-parse only the changed file
- Diff old graph nodes vs new → add/remove edges
- Update affected embeddings async
- Target: < 50ms per file update

**Graph queries** (powers the `graph` retrieval engine):
- `neighbors(nodeId, hops, edgeTypes)` — k-hop traversal from a code symbol
- `callers(functionId)` — who calls this function
- `callees(functionId)` — what does this function call
- `imports(fileId)` — what modules does this file import
- `dependents(fileId)` — what files depend on this file
- `search(pattern)` — fuzzy symbol search

**Integration with `compile()`**:
- The code graph becomes a retrieval engine in Phase B's fusion pipeline
- Working set (open files/symbols) → graph neighborhood retrieval
- "What code is relevant to this task" answered by graph traversal, not grep

**Tests**:
- Full build produces a valid graph for a test workspace
- Incremental update on file change modifies only affected nodes/edges
- `neighbors()` returns correct k-hop results
- Performance: incremental update < 50ms per file
- Rebuild from cold < 5s for a 1000-file workspace

**Estimated effort**: 8–10 days

---

### Track 3: Event-Sourced Sessions (Agent 3)

**Goal**: Replace stateless per-turn session handling with an event-sourced model that enables fork, replay, and time-travel.

**Deliverables**:
- `packages/engram/src/session/event-log.ts` — Session event DAG
- `packages/engram/src/session/types.ts` — Session event types
- `packages/engram/src/session/fork.ts` — Fork a session at any point
- `packages/engram/src/session/replay.ts` — Deterministic replay
- `packages/engram/src/session/diff.ts` — Diff two session branches
- `apps/cli/src/commands/session-fork.ts` — CLI command to fork
- `apps/cli/src/commands/session-replay.ts` — CLI command to replay
- `apps/cli/src/commands/session-list.ts` — CLI command to list sessions

**Session event types**:

```typescript
// packages/engram/src/session/types.ts

export type SessionEvent =
  | { type: "session_start"; sessionId: string; parentId?: string; createdAt: number }
  | { type: "turn_start"; turnId: string; taskFrame: TaskFrame }
  | { type: "context_compiled"; turnId: string; window: ContextWindowMetadata }
  | { type: "model_request"; turnId: string; model: string; tokens: number }
  | { type: "model_response"; turnId: string; content: string; tokens: number }
  | { type: "tool_call"; turnId: string; tool: string; input: unknown; result: unknown }
  | { type: "memory_write"; turnId: string; recordId: string; kind: RecordKind }
  | { type: "turn_end"; turnId: string; outcome: "success" | "failure" | "interrupted" }
  | { type: "session_end"; reason: string }
  ;

export interface Session {
  id: string;
  parentId?: string;          // If forked, points to parent session
  forkPoint?: number;         // Event index in parent where this forked
  events: SessionEvent[];
  createdAt: number;
  status: "active" | "completed" | "forked";
}
```

**Event-sourcing properties**:
- Events are append-only — no mutations to past events
- The session state is derived from replaying events
- Any past state is reconstructible by replaying events up to that point
- Fork = create a new session with `parentId` + `forkPoint`, continue from there
- Replay = step through events deterministically, verifying context compilation produces the same window

**Fork workflow**:
1. User: `cortex session fork --at turn-3`
2. Daemon creates new session with `parentId` = current, `forkPoint` = turn 3
3. Events 0..turn-3 from parent are the "prefix" of the forked session
4. New events append to the forked branch
5. Both branches remain readable

**Replay workflow**:
1. User: `cortex session replay session-abc`
2. Daemon reads events from session-abc
3. For each turn: reconstruct `taskFrame`, call `compile()`, verify output matches
4. Report divergences (if code changed since recording, context may differ)
5. Useful for debugging: "why did the agent do X?"

**Tests**:
- Session records all events from a multi-turn interaction
- Fork creates a valid branch that shares prefix with parent
- Replay produces the same context windows given the same store state
- Session survives daemon restart (persisted in DuckDB)
- Event ordering is preserved and deterministic

**Estimated effort**: 7–8 days

---

### Track 4: CLI Surface Migration (Agent 4)

**Goal**: Migrate the CLI's agent interaction surface to use structured tool I/O, differential context, and budget telemetry.

**Deliverables**:
- `apps/cli/src/components/budget-display.tsx` — Ink component showing token budget allocation
- `apps/cli/src/components/context-stats.tsx` — Ink component showing compile() metrics
- `apps/cli/src/lib/structured-tool-io.ts` — Wrapper that indexes tool results
- `apps/cli/src/lib/differential-context.ts` — Delta tracking between turns
- Modified: `apps/cli/src/commands/chat.ts` — Use daemon + compiled context

**Structured tool I/O**:

```typescript
// apps/cli/src/lib/structured-tool-io.ts

export interface StructuredToolResult {
  toolName: string;
  success: boolean;
  summary: string;              // One-line summary for context
  data: unknown;                // Typed payload (file content, command output, etc.)
  metadata: {
    executionMs: number;
    tokenEstimate: number;
    retrievalHandle?: string;   // Engram record ID for page-back-in
  };
}

// Wrap existing tool execution to produce structured results
export function wrapToolExecution(tool: CapabilityHandler): CapabilityHandler {
  return async (input, ctx) => {
    const start = Date.now();
    const result = await tool(input, ctx);
    const structured = structureResult(tool.name, result, Date.now() - start);

    // Index in Engram for future retrieval
    await engram.remember({
      event: "tool_result",
      payload: structured,
      outcome: structured.success ? "success" : "failure",
    }, { namespace: ctx.namespace, provenance: { author: "cortex", derivedFrom: [], timestamp: Date.now() } });

    return structured;
  };
}
```

**Differential context**:
- Between turns, compute diff from `compile()` output
- Log: "Added 3 records (+450 tokens), evicted 2 records (-200 tokens), net: +250"
- Show in TUI: what's in context, what was added/removed this turn
- Flat token cost over session length (not growing linearly)

**Budget telemetry in TUI** (Ink component):

```
╭─ Context Budget ────────────────────────────────────╮
│ System:     1,200 / 1,500 tokens  [████████░░] 80%  │
│ Rules:        800 / 1,000 tokens  [████████░░] 80%  │
│ Code:       2,100 / 3,000 tokens  [███████░░░] 70%  │
│ Retrieved:  4,500 / 5,000 tokens  [█████████░] 90%  │
│ Working:    1,400 / 2,000 tokens  [███████░░░] 70%  │
│ ─────────────────────────────────────────────────── │
│ Total:     10,000 / 12,500 tokens [████████░░] 80%  │
│ Cache hit:  72% | Compile: 8ms | Delta: +250 tokens │
╰─────────────────────────────────────────────────────╯
```

**Tests**:
- Structured tool results are indexed in Engram
- Budget display renders correctly in Ink
- Differential context shows flat token growth over 10-turn session
- CLI commands work with daemon running (fast path)
- CLI commands work without daemon (slow fallback)

**Estimated effort**: 6–7 days

---

## Deliverables Checklist

- [ ] Context daemon running as persistent local service
- [ ] Daemon protocol (JSON-RPC over Unix socket)
- [ ] Daemon lifecycle (auto-start, health check, auto-stop)
- [ ] Incremental code graph with file-watch
- [ ] Code graph queries (neighbors, callers, callees, imports)
- [ ] Code graph integrated as retrieval engine in `compile()`
- [ ] Event-sourced sessions (append-only event log)
- [ ] Session fork and replay commands
- [ ] Structured tool I/O (indexed results, not raw text)
- [ ] Differential context tracking
- [ ] Token budget telemetry in Ink TUI
- [ ] CLI cold start < 500ms with daemon running

---

## Success Criteria

| Metric | Target |
|---|---|
| CLI cold start (daemon warm) | < 500ms |
| Code graph incremental update | < 50ms per file |
| Code graph full build (1000 files) | < 5s |
| Session fork/replay round-trip | Events preserved, deterministic |
| Tool results indexed | 100% of tool calls produce Engram records |
| Token cost growth over session | Flat (not linear/quadratic) |
| Daemon uptime | > 99% during development sessions |

---

## Dependencies on Other Phases

| Depends On | Details |
|---|---|
| Phase B | `compile()` must be working — daemon calls it every turn |
| Phase B | Retrieval engines must accept code graph as a source |

| Depended On By | Details |
|---|---|
| Phase F | Rust interface spec covers daemon hot paths |
| Phase F | Eval harness measures CLI session performance |

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Daemon stability (crashes under load) | Medium | Watchdog process, graceful restart, fallback to inline |
| File watcher performance (large repos) | Medium | Respect .gitignore, debounce, limit watched depth |
| Tree-sitter WASM too slow for incremental | Low | Use native tree-sitter binary via node-addon |
| Unix socket permissions on shared machines | Low | Per-user socket path; configurable |
| Session replay diverges due to non-determinism | Medium | Record all inputs including timestamps; mock time in replay |

---

## Files Created / Modified

### Created
| File | Purpose |
|---|---|
| `apps/cli/src/daemon/server.ts` | Daemon main process |
| `apps/cli/src/daemon/client.ts` | CLI → daemon client |
| `apps/cli/src/daemon/lifecycle.ts` | Start/stop/health |
| `apps/cli/src/daemon/state.ts` | Persistent state |
| `apps/cli/src/daemon/watcher.ts` | File system watcher |
| `apps/cli/src/daemon/protocol.ts` | JSON-RPC protocol types |
| `apps/cli/src/daemon/code-graph/builder.ts` | Initial graph build |
| `apps/cli/src/daemon/code-graph/watcher.ts` | Incremental updates |
| `apps/cli/src/daemon/code-graph/query.ts` | Graph query API |
| `apps/cli/src/daemon/code-graph/types.ts` | Code entity types |
| `apps/cli/src/components/budget-display.tsx` | Token budget TUI |
| `apps/cli/src/components/context-stats.tsx` | Compile metrics TUI |
| `apps/cli/src/lib/structured-tool-io.ts` | Tool result wrapper |
| `apps/cli/src/lib/differential-context.ts` | Delta tracker |
| `apps/cli/src/commands/session-fork.ts` | Fork command |
| `apps/cli/src/commands/session-replay.ts` | Replay command |
| `apps/cli/src/commands/session-list.ts` | Session list command |
| `apps/cli/src/commands/daemon-start.ts` | Daemon start command |
| `apps/cli/src/commands/daemon-stop.ts` | Daemon stop command |
| `apps/cli/src/commands/daemon-status.ts` | Daemon status command |
| `packages/engram/src/session/event-log.ts` | Session event DAG |
| `packages/engram/src/session/types.ts` | Event types |
| `packages/engram/src/session/fork.ts` | Fork logic |
| `packages/engram/src/session/replay.ts` | Replay logic |
| `packages/engram/src/session/diff.ts` | Session branch diff |
| `packages/engram/src/retrieval/code-graph.ts` | Code graph retrieval engine |

### Modified
| File | Change |
|---|---|
| `apps/cli/src/commands/chat.ts` | Use daemon + compiled context |
| `apps/cli/src/lib/api-client.ts` | Add daemon client fallback |
| `apps/cli/package.json` | Add chokidar, tree-sitter deps |
| `packages/engram/src/index.ts` | Export session module |
