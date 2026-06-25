# Context Engine Vision Spec — Oxagen Platform Transformation

> The Cortex + Engram thesis applied to the Oxagen platform: transforming an enterprise AI
> capability kernel into a context-engineered, memory-first agent system.

---

## 1. Thesis Restated for Oxagen

Oxagen today is a **capability kernel** — a unified `invoke()` surface across API, MCP, web, and CLI. Every feature routes through contracts, gates, and handlers. This is correct architecture for an enterprise platform, but the agent layer treats context as an afterthought: system prompt + full message history + tool list, assembled ad-hoc each turn.

The transformation: make the capability kernel **context-aware**. Every `invoke()` call — whether from a human in the web app or an agent in a tool loop — benefits from a compiled, budget-constrained, cache-aligned context window assembled from a structured memory substrate.

**Engram** becomes the memory substrate and context compiler that powers the agent runtime in `packages/agent`. **Cortex** evolves the existing `apps/cli` into a context-daemon-backed agent harness that proves the engine works at the developer-facing edge before rolling it into the cloud surfaces.

### Core Principles

1. **Context is compiled, not assembled** — the `compile()` function replaces ad-hoc prompt construction
2. **Memory is typed, not prose** — structured records replace free-text in Neo4j AgentMemory nodes
3. **Write cheap, read smart** — episodic events append non-blocking; derivation happens async
4. **Local-first read path** — no network hop on the critical `compile()` call
5. **Cache stability as constraint** — layout optimizes for provider prompt-cache hits
6. **TypeScript-first, Rust-later** — ship value in the stack we have; plan the interface for rewrite

---

## 2. Current Architecture → Target Architecture

### What We Have (Capability Kernel + Agent Runtime)

```
┌─────────────────────────────────────────────────────────┐
│                    SURFACES                               │
│   apps/api   apps/app   apps/mcp   apps/cli             │
└────────────────────┬────────────────────────────────────┘
                     │ invoke()
┌────────────────────▼────────────────────────────────────┐
│              packages/oxagen (kernel)                     │
│   contracts → gates (IAM/billing/entitlement) → handler │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              packages/agent (runtime)                     │
│   materialize-tools → LLM loop → knowledge-graph inject │
│   context: system prompt + history + tools (ad-hoc)     │
└─────────────────────────────────────────────────────────┘
                     │
    ┌────────────────┼──────────────────┐
    ▼                ▼                  ▼
 Postgres        Neo4j              ClickHouse
 (16 schemas)   (graph+vector)     (events)
```

### What We're Building (Context-Engineered Agent Platform)

```
┌─────────────────────────────────────────────────────────┐
│                    SURFACES                               │
│   apps/api   apps/app   apps/mcp   apps/cli (Cortex)    │
└────────────────────┬────────────────────────────────────┘
                     │ invoke()
┌────────────────────▼────────────────────────────────────┐
│              packages/oxagen (kernel)                     │
│   contracts → gates → handler                            │
│   + context gate: inject compiled context per-turn      │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              packages/agent (runtime)                     │
│   tool-loop invokes engram.compile() each turn          │
│   structured tool I/O → indexed, not pasted             │
│   event-sourced session → fork, replay, diff            │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              packages/engram (NEW)                        │
│                                                          │
│   ┌─────────────────┐     ┌──────────────────────────┐  │
│   │ Context Compiler │◄───►│ Memory Substrate         │  │
│   │ compile()        │     │ episodic · semantic ·    │  │
│   │ knapsack pack    │     │ procedural · entity      │  │
│   │ cache-align      │     │ content-addressed        │  │
│   │ differential     │     │ typed records            │  │
│   └─────────────────┘     └──────────────────────────┘  │
│          ▲                          ▲                    │
│   ┌──────┴───────┐    ┌────────────┴─────────────────┐  │
│   │   Indexes    │    │   Consolidation ("sleep")    │  │
│   │ vec/lex/graph│    │   episodic→semantic          │  │
│   │ /temporal    │    │   salience, decay, promote   │  │
│   └──────────────┘    └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                     │
    ┌────────────────┼──────────────────┐
    ▼                ▼                  ▼
 Postgres        Neo4j              ClickHouse
 (transactional) (entity graph)    (episodic log)
```

---

## 3. Mapping Vision to Existing Architecture

### Direct Alignments (Keep + Evolve)

| Vision Concept | Oxagen Today | Transformation |
|---|---|---|
| Memory (episodic) | ClickHouse events + agent telemetry | Add content addressing, causality DAG, Merkle sync |
| Memory (semantic) | Neo4j `AgentMemory` nodes (`packages/agent/src/memory/neo4j.ts`) | Migrate to typed Engram records with confidence, conflict resolution, decay |
| Memory (procedural) | `packages/skills` (`.skill.md` + YAML frontmatter) | Skills become retrievable procedural records, injected by relevance |
| Memory (entity/relational) | Neo4j ontology (`packages/ontology`) with 30+ edge types | Add temporal indexing, salience scoring, incremental maintenance |
| Multi-tenancy | `packages/tenancy` with RLS via `runInTenantScope` | Engram namespaces map to org/workspace/session/agent scoping |
| Background processing | `packages/inngest-functions` (durable execution) | Consolidation jobs run as Inngest functions |
| Agent tool loop | `packages/agent/src/runtime` (materialize-tools, approval, dispatch) | Replace context injection with `engram.compile()` |
| Ingestion | `packages/ingestion` (connectors, tree-sitter, embed, infer) | Incremental code graph + structured entity maintenance |
| Telemetry | `packages/telemetry` (ClickHouse events) | Becomes the episodic event source for consolidation |

### Gaps (Net-New)

| Concept | Status | Package Location |
|---|---|---|
| Context compiler (`compile()`) | Does not exist | `packages/engram/src/compiler/` |
| Content-addressed records | Does not exist | `packages/engram/src/record.ts` |
| Cache-aware layout | Does not exist | `packages/engram/src/compiler/layout.ts` |
| Differential context | Does not exist | `packages/engram/src/compiler/diff.ts` |
| Knapsack packing | Does not exist | `packages/engram/src/compiler/packer.ts` |
| Hybrid retrieval fusion | Does not exist | `packages/engram/src/retrieval/` |
| Consolidation pipeline | Does not exist | `packages/engram/src/consolidation/` |
| Salience/decay model | Does not exist | `packages/engram/src/salience.ts` |
| Event-sourced sessions | Does not exist | `packages/engram/src/session/` |
| Context daemon | Does not exist | `apps/cli/src/daemon/` (Cortex) |
| Multi-agent blackboard | Partial (research swarm) | `packages/engram/src/blackboard/` |
| CRDT sync | Does not exist | `packages/engram/src/sync/` (Phase F) |

### Misaligned (De-scope or Realign)

| Feature | Problem | Action |
|---|---|---|
| `readWorkspaceContext` (OXA-1508) | Returns `[]`, feature-flagged dead code | Replace entirely with `engram.compile()` |
| Playbook system (`automation.*`) | Event-trigger automation overlaps with agent workflows | Freeze; revisit as procedural memory triggers |
| `workflow.*` schema | Duplicates `agent.agent_executions` | Migrate to event-sourced session model |
| Content schema (`content.*`) | Generic document storage, not memory-aligned | Freeze; content becomes blob references in Engram records |
| Form generation capabilities | Tangential to context/memory mission | Sunset |
| Video/SVG/Image generation | Content creation unrelated to context engine | Freeze |
| Research swarm | Partial multi-agent without shared memory | Evolve into blackboard (Phase E) |
| MCP snapshots | Tool schemas snapshotted but not live-indexed | Replace with structured tool I/O index |

---

## 4. Target State Architecture Decisions

### ADR Candidates

| Decision | Rationale |
|---|---|
| Engram as a monorepo package (`packages/engram`) | Same build/test/lint pipeline; shares types with `packages/agent` and `packages/oxagen` |
| TypeScript-first with Rust interface spec | Ship value in weeks, not months; design the NAPI boundary from day 1 |
| Content addressing via blake3 | Fast, streaming, collision-resistant; WASM build available for TS |
| DuckDB for local episodic (dev/CLI) | Zero-dep embedded columnar; same query semantics as ClickHouse |
| ClickHouse for cloud episodic | Already deployed; append-only events are its sweet spot |
| Neo4j retained for entity graph | Good foundation; add temporal + salience properties |
| Skills remain filesystem-first | ADR-008 is correct; add retrieval index over them |
| Inngest for consolidation jobs | ADR-002 durable execution; consolidation is a perfect fit |
| `apps/cli` evolves to Cortex | 134 commands already exist; add daemon + context integration |

### Package Structure

```
packages/engram/
├── src/
│   ├── index.ts                 # Public API surface
│   ├── record.ts                # MemoryRecord type + content addressing
│   ├── store/                   # Storage adapters (episodic, semantic, entity)
│   │   ├── episodic.ts          # Append-only event log
│   │   ├── semantic.ts          # Fact store with confidence
│   │   ├── procedural.ts        # Rules/skills retrieval
│   │   └── entity.ts            # Graph adapter (Neo4j bridge)
│   ├── compiler/                # The context compiler
│   │   ├── compile.ts           # compile(taskFrame, budget) → ContextWindow
│   │   ├── retrieval.ts         # Multi-modal retrieval orchestrator
│   │   ├── packer.ts            # Knapsack budget optimizer
│   │   ├── layout.ts            # Cache-aware prompt layout
│   │   └── diff.ts              # Differential context (delta computation)
│   ├── retrieval/               # Individual retrieval engines
│   │   ├── vector.ts            # ANN search
│   │   ├── lexical.ts           # BM25 / exact match
│   │   ├── graph.ts             # Graph neighborhood traversal
│   │   ├── temporal.ts          # Recency-weighted recall
│   │   └── fusion.ts            # Reciprocal Rank Fusion
│   ├── salience.ts              # Salience scoring + decay
│   ├── consolidation/           # Background "sleep" pipeline
│   │   ├── distill.ts           # Episodic → semantic extraction
│   │   ├── promote.ts           # Pattern → procedural promotion
│   │   ├── decay.ts             # Time/value-based eviction
│   │   └── resolve.ts           # Conflict resolution
│   ├── session/                 # Event-sourced session model
│   │   ├── event-log.ts         # Session event DAG
│   │   ├── fork.ts              # Session forking
│   │   └── replay.ts            # Deterministic replay
│   ├── blackboard/              # Multi-agent shared memory
│   │   ├── bus.ts               # Scoped memory bus
│   │   ├── namespace.ts         # Hierarchical namespace enforcement
│   │   └── intent.ts            # Intent ledger for coordination
│   ├── sync/                    # CRDT + Merkle (Phase F)
│   │   ├── crdt.ts
│   │   └── merkle.ts
│   └── types.ts                 # Shared type definitions
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 5. Success Metrics

| Metric | Current | Target (Phase B complete) | Target (Phase D complete) |
|---|---|---|---|
| Context assembly latency | N/A (ad-hoc string concat) | p50 < 10ms, p99 < 50ms | p50 < 5ms, p99 < 25ms |
| Prompt cache hit rate | 0% (unstable layout) | > 60% | > 80% |
| Tokens per turn (long session) | Linear growth | Flat (differential) | Flat + declining (learning) |
| Agent memory recall precision | Unknown (grep-only) | > 70% (hybrid retrieval) | > 85% (reinforced) |
| Context window utilization | ~30% useful content | > 70% task-relevant | > 85% task-relevant |
| Cold start time (CLI) | 2-5s (full rebuild) | < 500ms (daemon) | < 200ms (warm cache) |

---

## 6. Migration Strategy

The transformation is **additive first, subtractive second**:

1. Build `packages/engram` alongside existing code
2. Wire `engram.compile()` into the agent runtime as an opt-in replacement for current context injection
3. Validate with the CLI surface (lowest risk, fastest feedback)
4. Roll out to API/MCP surfaces behind feature flags
5. Migrate existing AgentMemory data from Neo4j → Engram records
6. Remove dead code paths (`readWorkspaceContext`, ad-hoc assembly)

At no point does the platform break. The capability kernel continues to work. Engram is a new package that the agent runtime optionally consults; the old path remains until the new path proves superior.

---

## 7. Non-Goals (Explicit)

- **Not building a general-purpose vector DB** — Engram uses existing stores (Neo4j vector, DuckDB, ClickHouse) through adapters
- **Not replacing the capability kernel** — `invoke()` remains the one path; Engram powers context for capabilities, it doesn't replace them
- **Not building a new CLI from scratch** — `apps/cli` evolves; Commander + Ink stay
- **Not rewriting in Rust immediately** — TypeScript ships first; Rust interface spec is designed but not implemented until Phase F
- **Not breaking multi-tenancy** — Engram namespaces map directly to the existing `runInTenantScope` model
- **Not changing the storage boundary rule** — Postgres for transactional, Neo4j for graph, ClickHouse for events. Engram adds DuckDB as a local complement.
