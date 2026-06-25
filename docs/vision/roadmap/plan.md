# Context Engine — Master Plan

> Six phases (A–F) transforming Oxagen from ad-hoc context assembly to a compiled,
> memory-first agent platform. Each phase delivers standalone value. Phases A–C are
> the critical path; D–F are the moat.

---

## Phase Overview

| Phase | Name | Core Deliverable | Duration | Depends On |
|---|---|---|---|---|
| **A** | Memory Substrate | `packages/engram` with typed records, content addressing, episodic store | 4–6 weeks | — |
| **B** | Context Compiler | `engram.compile()` with hybrid retrieval, knapsack packing, cache-aware layout | 4–6 weeks | A |
| **C** | Cortex Harness | Context daemon, incremental code graph, event-sourced sessions, CLI evolution | 6–8 weeks | B |
| **D** | Consolidation | Background "sleep" job, salience/decay, reinforcement, procedural promotion | 4–6 weeks | B |
| **E** | Multi-Agent Blackboard | Shared scoped memory bus, namespace enforcement, intent ledger | 4–6 weeks | B, D |
| **F** | Performance & Sync | CRDT records, Merkle sync, Rust interface spec, eval harness | 6–8 weeks | D, E |

**Total estimated duration: 28–40 weeks with parallelism (see dependency graph below)**

---

## Dependency Graph

```
        ┌─────────┐
        │ Phase A │  Memory Substrate
        │ (wk 1-6)│
        └────┬────┘
             │
        ┌────▼────┐
        │ Phase B │  Context Compiler
        │(wk 5-10)│
        └────┬────┘
             │
     ┌───────┼───────┐
     │       │       │
┌────▼────┐  │  ┌────▼────┐
│ Phase C │  │  │ Phase D │    ← C and D can run in parallel after B
│(wk 9-16)│  │  │(wk 9-14)│
└─────────┘  │  └────┬────┘
             │       │
             │  ┌────▼────┐
             │  │ Phase E │    ← E needs D's consolidation + B's retrieval
             │  │(wk 13-18)│
             │  └────┬────┘
             │       │
             └───┬───┘
                 │
            ┌────▼────┐
            │ Phase F │    ← F needs E's blackboard + D's salience
            │(wk 17-24)│
            └─────────┘
```

### Parallelism Opportunities

- **Phases C and D run concurrently** — Cortex harness development is independent of consolidation pipeline work
- **Within each phase**, 3–4 parallel tracks are identified for concurrent agent execution
- **Phase A tracks 1+2** (record format + store implementation) can start simultaneously
- **Phase B tracks 1+2** (retrieval engines + packing algorithm) are independent
- **De-scoping work** (see `de-scope.md`) can run in parallel with Phase A

---

## Phase A: Memory Substrate + Content Addressing

**Goal**: Ship `packages/engram` with the foundational record type, content-addressing, and episodic store.

### Parallel Tracks

1. **Record format + types** — `MemoryRecord`, blake3 content addressing, namespace schema, Zod validation
2. **Episodic store adapters** — DuckDB (local/dev), ClickHouse (cloud), append-only write path
3. **Migration bridge** — Read existing `AgentMemory` from Neo4j, emit as Engram records
4. **Write-path API** — `engram.remember()`, `engram.assert()`, `engram.relate()`, `engram.pin()`

### Key Deliverables

- `packages/engram` package with build/test/lint passing in monorepo CI
- `MemoryRecord` type with content addressing (blake3 WASM)
- Episodic event log (DuckDB local, ClickHouse cloud adapter)
- Write API integrated into `packages/agent` runtime (behind feature flag)
- Migration script: Neo4j AgentMemory → Engram episodic records

### Success Criteria

- `pnpm gate` passes with `packages/engram` included
- Records are content-addressed (identical content → identical ID)
- Write latency < 100µs for episodic append (local DuckDB)
- Existing agent flows unaffected (feature-flagged)

### Exit Criteria → Phase B

- Record format is stable (no breaking changes to `MemoryRecord`)
- At least one store adapter is production-ready
- Write API is integrated and events are flowing

---

## Phase B: Context Compiler

**Goal**: Ship `engram.compile()` — the per-turn context assembly function that replaces ad-hoc prompt construction.

### Parallel Tracks

1. **Retrieval engines** — Vector (Neo4j ANN), BM25 (tantivy-wasm or lunr), graph neighborhood, temporal/recency
2. **Packing algorithm** — Knapsack optimizer with diversity constraints, token counting, budget enforcement
3. **Layout optimizer** — Cache-stable prefix ordering, section arrangement, compression for cold items
4. **Integration** — Wire `compile()` into `packages/agent/src/runtime`, replace `readWorkspaceContext`

### Key Deliverables

- `engram.compile(taskFrame, budget) → ContextWindow` function
- Hybrid retrieval with Reciprocal Rank Fusion
- Budget-constrained knapsack packing (not top-k)
- Cache-aware layout with stable prefix
- Agent runtime integration (opt-in, feature-flagged)

### Success Criteria

- `compile()` returns a valid, budget-respecting context window
- p50 latency < 10ms on project-scale corpus (warm)
- Retrieval precision > 70% on golden test cases
- Prompt cache hit rate > 60% on follow-up turns (measured)
- Agent runtime can use compiled context without regression

### Exit Criteria → Phase C, D

- `compile()` is stable and integrated
- Retrieval pipeline produces ranked candidates
- Layout produces cache-stable windows

---

## Phase C: Cortex Agent Harness (CLI Evolution)

**Goal**: Evolve `apps/cli` into a persistent, context-daemon-backed agent harness with incremental code graph and event-sourced sessions.

### Parallel Tracks

1. **Context daemon** — Persistent local service, socket API, warm index maintenance, file-watch subscription
2. **Incremental code graph** — tree-sitter + file-watch, symbol graph, "where is X used" as graph query
3. **Event-sourced sessions** — Session event DAG, fork/replay/time-travel, deterministic replay
4. **CLI surface migration** — Structured tool I/O, differential context, budget telemetry in TUI

### Key Deliverables

- Context daemon process (`apps/cli/src/daemon/`) with health check
- Incremental code graph maintained on file-watch (not per-session rebuild)
- Event-sourced session model with fork and replay
- Structured tool I/O (results indexed, not raw text pasted)
- Differential context (send deltas per turn, not full window)
- Token budget telemetry visible in Ink TUI

### Success Criteria

- Cold start < 500ms (daemon warm)
- Code graph updates incrementally on file save (< 50ms per file)
- Sessions are replayable (same inputs → same context compilation)
- Tool results are queryable by the retrieval engine
- Token cost per turn is flat or declining over session length

### Exit Criteria → Phase F

- Daemon is stable for local development use
- Code graph powers retrieval for code-related queries
- Sessions persist across CLI restarts

---

## Phase D: Consolidation & Learning

**Goal**: Background "sleep" job that distills episodic memory into durable knowledge, scores salience, and promotes successful patterns.

### Parallel Tracks

1. **Salience model** — Write-time heuristic scoring, decay function, reinforcement signal from outcomes
2. **Consolidation pipeline** — Inngest job: episodic → semantic distillation, dedup, conflict flag
3. **Procedural promotion** — Pattern detection (repeated successful sequences → rules), skills evolution
4. **Conflict resolution** — Multi-source fact conflicts, confidence adjustment, human escalation

### Key Deliverables

- Salience scoring on every `engram.remember()` call
- Exponential decay with value-based eviction (not LRU)
- Consolidation Inngest function: `engram.consolidation.run`
- Episodic → semantic distillation (extract durable facts)
- Procedural memory promotion (success patterns → rules)
- Conflict detection and resolution pipeline

### Success Criteria

- High-value memories surface more often in `compile()` results
- Unused memories decay below retrieval threshold over time
- Consolidation produces semantic records from episodic clusters
- Agent retrieval precision improves over time on repeated project work
- No silent fact overwrites (conflicts tracked with provenance)

### Exit Criteria → Phase E

- Salience model is calibrated and producing meaningful scores
- Consolidation job is running in production (Inngest)
- Conflict resolution policy is defined and enforced

---

## Phase E: Multi-Agent Blackboard

**Goal**: Replace ad-hoc subagent spawning with a coordinated memory bus where agents share discoveries without duplication.

### Parallel Tracks

1. **Blackboard protocol** — Shared scoped memory bus, pub/sub for memory events, discovery broadcast
2. **Namespace enforcement** — RLS at the Engram boundary, agent-scoped private + shared layers
3. **Agent coordination** — Intent ledger (prevent duplicate work), leases for exclusive resources
4. **Lineage tracking** — `derived_from` chains, which agent learned what from which input

### Key Deliverables

- Blackboard memory bus (`packages/engram/src/blackboard/`)
- Namespace-scoped read/write (private + shared layers per agent)
- Intent ledger: agents publish "I'm working on X"
- Lineage graph: full causal chain from source to derived knowledge
- Conflict resolution for multi-agent assertions
- Research swarm migrated to blackboard model

### Success Criteria

- Two agents on the same task don't duplicate grep/search work
- Discoveries by one agent are visible to peers within 1 turn
- Namespace enforcement prevents cross-tenant memory leakage
- Lineage is queryable ("why does the agent believe X?")
- Research swarm use cases work on the blackboard

### Exit Criteria → Phase F

- Blackboard is stable for multi-agent workflows
- Namespace enforcement passes security audit
- Intent ledger prevents > 90% of duplicate work

---

## Phase F: Performance, Sync, and the Rust Path

**Goal**: CRDT memory records, Merkle sync, quantized vectors for edge, Rust interface spec, and the eval harness as a regression gate.

### Parallel Tracks

1. **CRDT implementation** — OR-Set for semantic facts, PN-counter for salience, append-merge for episodic
2. **Sync protocol** — Merkle-diff anti-entropy, prioritized sync (high-salience first), hub-and-spoke
3. **Eval harness** — Context precision/recall, tokens-to-task-success, cache hit rate, cost per task
4. **Rust interface spec** — NAPI boundary design, data format for FFI, performance-critical hot paths

### Key Deliverables

- CRDT semantics on memory records (offline-safe concurrent writes)
- Merkle-diff sync between local and cloud (bytes ∝ changes)
- Quantized vectors (int8) for edge deployment
- Eval harness running as CI regression gate on golden traces
- Rust interface spec (types, FFI boundary, target performance)
- Ring buffer implementation for bounded edge memory

### Success Criteria

- Two offline agents can merge memory without conflicts
- Sync transfers only changed records (Merkle diff)
- Eval harness catches context quality regressions
- Rust interface spec is implementable without TS API changes
- Edge memory stays within configured bounds (ring buffer)

---

## Timeline Summary (Aggressive)

```
Week:  1  2  3  4  5  6  7  8  9  10 11 12 13 14 15 16 17 18 19 20 21 22 23 24
       ├──────────────────┤
       Phase A: Memory Substrate
                   ├──────────────────┤
                   Phase B: Context Compiler
                               ├────────────────────────────┤
                               Phase C: Cortex Harness
                               ├──────────────────┤
                               Phase D: Consolidation
                                              ├──────────────────┤
                                              Phase E: Multi-Agent
                                                          ├──────────────────────┤
                                                          Phase F: Perf & Sync
```

**Ship 1 value milestone per phase:**
- Phase A → "agent remembers structured events"
- Phase B → "agent context is compiled, not assembled"
- Phase C → "CLI is instant and persistent"
- Phase D → "agent gets smarter over time"
- Phase E → "agents coordinate without duplication"
- Phase F → "offline-first, sync, and the Rust future"

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| blake3 WASM performance insufficient | Low | Medium | Fallback to sha256; benchmark early in Phase A |
| DuckDB WASM too large for CLI bundle | Medium | Low | Use native DuckDB binary; lazy-load |
| Neo4j vector search too slow for p50 < 5ms | Medium | High | Add usearch/hnswlib local index; Neo4j becomes cold tier |
| Differential context breaks provider compatibility | Low | High | Feature-flag per provider; fallback to full context |
| Consolidation job produces low-quality semantic records | Medium | Medium | Start with conservative extraction; human review in Phase D |
| Rust rewrite scope creep | High | High | Strict interface-only spec in Phase F; no implementation |
| Multi-agent coordination deadlocks | Low | Medium | Timeout + fallback to independent execution |
