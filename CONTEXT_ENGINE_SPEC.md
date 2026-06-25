# Cortex + Engram — Spec for a faster agentic CLI and its context/memory engine

> A clean-sheet design for (1) a command-line agent in the spirit of Claude Code but
> faster and more reproducible, and (2) **Engram** — the context/state/memory engine that
> powers it, designed to run *identically* on a resource-constrained robot and in a
> multi-tenant cloud, and to be the shared brain for complex multi-agent workflows.

---

## 0. Thesis

Most "AI memory" products treat memory as **storage** (put text in a vector DB, fetch top-k).
That is the wrong frame and it is why agents feel forgetful and slow.

The right frame: **context engineering is a per-turn compilation problem under a hard token
budget and a hard latency budget.** The model has a fixed attention window per call. The job
of the engine is, every single turn, to *compile* the best possible window from a corpus that
is orders of magnitude larger than the window — with microsecond-to-low-millisecond latency on
the read path, and to do the *writing/learning* asynchronously off the critical path.

So Engram is two cooperating machines:

1. **A memory substrate** — append-only, content-addressed, tiered, locally-embeddable,
   conflict-free under concurrent multi-agent and offline writes.
2. **A context compiler** — a cost-based query planner that assembles a prompt-cache-aligned,
   token-budgeted window each turn, and ships only the *delta* from the previous turn.

The CLI (**Cortex**) is a thin, deterministic harness around that engine.

---

## 1. What Claude Code gets right, and where the performance is left on the table

Keep (these are genuinely good):

- File-based, human-readable rules/memory (`CLAUDE.md`), hooks, permissions, MCP, skills.
- Subagents for context isolation.
- A tight tool loop with bash/edit/grep/glob and a permission model.

Where it leaves speed and quality on the table — and what Engram/Cortex fix:

| Limitation today | Cost | Fix |
|---|---|---|
| Context is **rebuilt per session**; files re-read; no persistent index | Latency + tokens on every cold start | **Persistent context daemon** with an incrementally-maintained code graph + indexes |
| **Compaction is lossy and irreversible** — summarize-and-discard | Silent information loss mid-task | **Summaries with pointers** — page the original back in on demand (no destruction) |
| Memory is **unstructured prose** in markdown | Can't dedup, rank, decay, or resolve conflicts | **Typed memory records** with salience, provenance, confidence, TTL |
| Tools return **raw text blobs** | Re-parsed every turn; pollutes the window | **Structured tool I/O**; results are indexed, not pasted |
| Subagents **lose context** and can't share findings | Duplicated work, lost discoveries | **Blackboard** — shared, scoped, lineage-tracked memory bus |
| Prompt assembly is **not cache-stable** | Provider prompt cache misses → slow + expensive | **Cache-aware layout**: byte-stable prefix, only the tail varies |
| Each turn re-sends most of the window | Tokens + latency scale with history | **Differential context** — send patches, not the whole window |
| No **replay / determinism** | Can't debug, fork, or reproduce a run | **Event-sourced sessions** — fork, replay, time-travel, diff |
| Retrieval is **grep-only** breadth search | Slow, recall gaps | **Hybrid retrieval**: vector + lexical + graph + recency + pinned |

---

## 2. Product overview

```
                         ┌─────────────────────────────────────────────┐
   cortex CLI / TUI ─────┤                                             │
   editor plugin    ─────┤            ENGRAM ENGINE (daemon/lib)       │
   MCP server       ─────┤                                             │
   subagents        ─────┤   ┌──────────────┐    ┌──────────────────┐  │
   robot runtime    ─────┤   │   Context    │    │   Memory         │  │
                         │   │   Compiler   │◄──►│   Substrate      │  │
                         │   │ (read path)  │    │ (write path)     │  │
                         │   └──────────────┘    └──────────────────┘  │
                         │        ▲                      ▲             │
                         │        │                      │             │
                         │   ┌──────────────┐    ┌──────────────────┐  │
                         │   │  Indexes     │    │  Consolidation   │  │
                         │   │ vec/lex/graph│    │  ("sleep") job   │  │
                         │   │ /temporal    │    │  async, off-path │  │
                         │   └──────────────┘    └──────────────────┘  │
                         └─────────────────────────────────────────────┘
                                    ▲                       ▲
                          local SSD / mmap          cloud object store
                          (hot + warm tiers)         (cold + sync hub)
```

**Engram** is one library with two deployment profiles (§7): an embeddable in-process build
for robots/edge, and a sharded service build for the cloud. Same data model, same query
language, same record format. **Cortex** is the agent harness that uses it.

---

## 3. Engram: the memory substrate

### 3.1 Memory taxonomy (cognitive architecture, engineered)

Five layers, each with different read/write/decay characteristics:

- **Working memory** — the live turn's scratchpad. Ephemeral, in-RAM, never persisted raw.
- **Episodic memory** — the event log: every tool call, observation, decision, and outcome.
  Append-only, time-indexed, bounded by ring buffer (edge) or partitions (cloud). This is the
  source of truth from which everything else is derived.
- **Semantic memory** — distilled, deduplicated facts ("auth = Better Auth", "prod DB host
  = X"). Embeddable, conflict-resolved, confidence-scored.
- **Procedural memory** — rules, skills, and policies ("always run the narrowest test",
  "use `withTenantDb`"). This is `CLAUDE.md`/skills evolved into structured, versioned,
  *testable*, *retrievable* units that are injected by relevance, not all-at-once.
- **Entity/relational memory** — a knowledge graph of code symbols, files, services, people,
  tickets, and their edges. The high-value layer for coding and for robots (object/world model).

> Episodic is written cheaply and continuously. The other four are *derived* from episodic by
> the async consolidation job (§5). This separation is what keeps the write path fast.

### 3.2 Storage architecture: tiered + four-store + local-first

**Memory hierarchy** (mirrors a CPU's, intentionally):

| Tier | Medium | Latency | Holds |
|---|---|---|---|
| L0 working | process RAM | ns | current turn |
| L1 hot | mmap'd local file | µs | active session episodic + hot semantic + resident graph neighborhood |
| L2 warm | local SSD (embedded DB) | sub-ms | full project memory, full code graph, vector index |
| L3 cold | cloud object store | 10–100 ms | archive, cross-project, multi-device sync hub |

**Four specialized stores** (you converge on this independently because each access pattern
wants a different engine — relational ≠ graph ≠ append-only ≠ binary):

- **Relational/KV** → transactional state: sessions, leases, namespaces, config, the salience
  ledger. (Embedded: SQLite/`redb`/LMDB. Cloud: Postgres.)
- **Graph** → entity/relational memory and lineage. (Embedded: an in-process adjacency store
  over the KV. Cloud: a graph DB, or Postgres+recursive CTEs at small scale.)
- **Append-only columnar** → episodic events + telemetry. (Embedded: Parquet/DuckDB segments.
  Cloud: ClickHouse.)
- **Blob** → binaries: screenshots, sensor keyframes, large artifacts. Reference rows live in
  relational; bytes live in blob/object store.

**Local-first is non-negotiable for the read path.** Even the cloud profile keeps a hot
working set in-process so a turn never blocks on a network hop for context. Cloud is the sync
hub and cold tier, not the critical path.

### 3.3 The record: content-addressed, like git-for-memory

Every memory write is an **immutable, content-addressed event** in a Merkle DAG:

```
MemoryRecord {
  id:          blake3(content)          // content address → free dedup + verifiable provenance
  kind:        episodic | semantic | procedural | entity | edge
  namespace:   org/project/workspace/session/agent   // hierarchical scope (§6)
  body:        <typed payload>          // structured, not raw prose
  embedding:   [int8; D]                // quantized; optional / lazy
  salience:    f32                      // importance at write time (§5)
  confidence:  f32                      // for facts that may be wrong
  provenance:  { author, derived_from: [id...], tool, model, ts }
  causality:   [parent_ids...]          // DAG edges → fork/replay/time-travel
  ttl / decay: policy ref
}
```

Why content addressing wins:

- **Dedup is free** — identical content → identical id.
- **Sync is cheap** — transfer only missing blocks (Merkle diff), exactly like git/IPFS. Critical
  for intermittently-connected robots.
- **Provenance & reproducibility** — any context window is a set of ids; you can prove what the
  agent saw and replay it byte-for-byte.
- **Time-travel & fork** — the causality DAG lets you branch a session and replay.

### 3.4 Indexes (built off the episodic log, async)

- **Vector** — embedded ANN (HNSW/IVF-PQ). Quantize to int8 or binary on edge; keep a small
  re-rank set in fp16. (Embedded: `usearch`/`hnswlib`/LanceDB. Cloud: same or a vector service.)
- **Lexical** — BM25 / tantivy for exact symbols, error strings, identifiers. Vectors miss exact
  tokens; you need both.
- **Graph** — typed edges for traversal ("who calls X", "what owns this file").
- **Temporal** — time + recency index over episodic for "what just happened" and decay.

Retrieval always runs these **in parallel** and fuses (§4.2). No single modality is sufficient.

### 3.5 Consistency & sync: CRDT, offline-first

Many agents (and offline robots) write concurrently. You cannot take locks on the hot path.

- The episodic log is **append-only and commutative** — merging two logs = set-union of
  content-addressed events. No conflicts possible.
- Derived layers use **CRDT semantics**: semantic facts as an **OR-Set** (add/remove with
  causal tags); the graph as a **2P/OR-Set of edges**; counters (salience hits) as **PN/G-
  counters**. Contradictory facts are **both retained** with provenance + confidence and flagged
  for the resolver (§6.4) — never silently overwritten.
- **Sync** is a Merkle-diff anti-entropy protocol: peers exchange root hashes, walk the DAG,
  pull missing blocks. Works peer-to-peer (robot↔robot) and hub-and-spoke (edge↔cloud).
- **Prioritized sync** for edge: safety-critical and high-salience records sync first; cold
  episodic backfills opportunistically.

---

## 4. Engram: the context compiler (the read path — this is the speed)

Every turn, `compile(task_frame, budget) → ContextWindow`. Target: **p50 < 5 ms, p99 < 25 ms**
on the warm tier for a project-scale corpus (excluding the model call itself).

### 4.1 Inputs

A **task frame**: current goal, active constraints, recent N episodic events, the working set
(open files/symbols/objects), and the agent's namespace. Cheap to build; mostly already in RAM.

### 4.2 Retrieve → fuse → rerank

1. **Parallel multi-modal retrieval** (the "multi-angle sweep"): vector(semantic), BM25(exact),
   graph(k-hop from working set), temporal(recent), and **pinned/procedural** (rules that always
   apply or match the task). Each is blind to the others, so together they cover failure modes a
   single index can't.
2. **Fusion** via Reciprocal Rank Fusion, then a **cost-based score**:
   `score = w_rel·relevance + w_rec·recency + w_imp·salience + w_out·outcome − w_tok·token_cost`
   where `outcome` = "did using this memory before lead to task success" (reinforcement, §5).
3. **Rerank** the top candidates with a tiny fast cross-encoder (or a cheap model) only when the
   budget is tight — skip it when retrieval confidence is high (adaptive cost).

### 4.3 Pack under budget (knapsack, not top-k)

Top-k is wrong; you want **maximum task-value per token**. Solve a budgeted knapsack over
candidates with diversity/dedup constraints (don't pack five paraphrases of the same fact).
Hot, directly-relevant items go **verbatim**; cold/supporting items go **compressed** (a summary
+ a retrieval handle), so nothing is lost — the agent can page the original back in.

### 4.4 Cache-aware layout (huge, underrated win)

Lay the window out so the **prefix is byte-stable across turns**: `[system] [procedural rules]
[stable project facts] [code-graph skeleton] … [volatile: retrieved task context] [working
memory]`. Stable prefix → provider **prompt-cache hits** → big latency + cost reduction. Most
tools destroy cache by reordering context every turn; Engram treats cache alignment as a
first-class layout constraint and only mutates the tail.

### 4.5 Differential context (send patches, not the window)

Maintain a per-session **context state** (the set of record ids currently resident in the
model's view). Each turn, compute the **diff** vs the previous turn and emit add/evict ops. The
prompt grows with *change*, not with *history length*. Combined with summaries-with-pointers,
this keeps long sessions flat in cost instead of quadratic.

### 4.6 Speculative prefetch

While the model is generating, predict the next files/symbols/objects it will touch (from the
graph neighborhood and the action distribution of similar past episodes) and warm them into L1.
By the time the next tool call lands, the context is already resident.

---

## 5. Engram: the write path, salience, decay, consolidation

The write path must be **cheap and non-blocking**. Agents emit episodic events; everything else
is derived asynchronously.

- **Salience on write** — a fast heuristic/small-model score: novelty, goal-relevance, surprise
  (prediction error), and explicit "remember this" signals. High-salience events get richer
  derivation.
- **Decay** — exponential time decay on episodic; importance is `f(recency, frequency, salience,
  outcome)`. Not LRU — *value*-based eviction.
- **Reinforcement** — when a memory is retrieved *and* the turn it fed succeeded, bump its
  outcome score; repeatedly-useless memories decay out. The corpus self-tunes toward what works.
- **Consolidation ("sleep")** — a background job, off the critical path, that:
  - distills episodic → semantic (extract durable facts),
  - dedups and **resolves conflicts** (merge OR-Sets, raise/lower confidence),
  - promotes recurring successful procedures → procedural memory ("you keep doing X before Y →
    make it a rule"),
  - updates the entity graph, re-embeds, and prunes/compresses cold episodic to summaries-with-
    pointers. Runs on idle, on a timer, or on a budget — like memory consolidation during sleep.

This is the loop that turns "a log of what happened" into "knowledge and skills," and it's why
the agent gets *better and faster* at a codebase/environment over time instead of just bigger.

---

## 6. Multi-agent layer: the shared brain

### 6.1 Blackboard

A shared, scoped memory bus. Each agent has **private working memory** + **scoped read/write**
to shared episodic/semantic/graph layers. Discoveries are written once and visible to all peers
— no re-derivation, no duplicated grep sweeps.

### 6.2 Namespaces & access control

`org → project → workspace → session → agent`. Every record is scoped; reads/writes are
RLS-style enforced at the engine boundary (tenancy is not optional). An agent sees its own
private layer plus the shared layers it's entitled to. This is also the multi-tenant cloud story.

### 6.3 Lineage & provenance

Every record carries `derived_from` and `author`. You get a full causal graph: *which* agent
learned *what*, from *which* inputs, with *what* confidence. Essential for debugging multi-agent
runs and for trust ("why does the agent believe this?").

### 6.4 Conflict resolution

When agents assert contradictory facts, keep both with provenance + confidence; a resolver
(policy, a model, or a human) adjudicates. Never last-writer-wins on knowledge.

### 6.5 Coordination primitives

- **Intent ledger** — agents publish "I'm doing X on files F" so others don't duplicate. A
  cheap, CRDT-friendly way to prevent two agents fixing the same bug.
- **Leases/locks** — for genuinely exclusive resources (a worktree, a migration).
- **Pub/sub** — agents subscribe to memory events ("new finding in module M") and react.

This turns ad-hoc subagent spawning into a coordinated swarm with a shared, growing world model.

---

## 7. Same engine, two profiles: robots and cloud

The differentiator: **one engine, two builds, identical data model and query language.**

### 7.1 Edge / robot profile (embeddable, in-process)

- In-process library, no daemon, no network on the read path. mmap + embedded KV + embedded
  ANN. Answers in µs–low-ms.
- **Bounded footprint**: fixed-size ring buffer for episodic; **quantized** (int8/binary)
  vectors; on-device small embedding model; resident only the graph neighborhood you need.
- **Hard-real-time safe**: the safety/control path never blocks on cloud. Memory is advisory to
  control, never in the way of it.
- **Intermittent connectivity**: offline-first; CRDT Merkle-diff sync when the link returns;
  safety-critical/high-salience records sync first.
- **Multimodal episodic**: sensor streams ingested as keyframed, downsampled episodes; the
  entity graph *is* the robot's world/object model.
- **Privacy at the edge**: raw sensor data and PII stay local; only distilled, non-PII semantic
  memory syncs up.

### 7.2 Cloud profile (sharded service)

- Same code, sharded by namespace; Postgres/ClickHouse/graph/vector + object store behind the
  same API. Horizontal scale, multi-tenant, the **sync hub** and **cold tier** for all edge nodes.
- Runs the heavy consolidation, cross-project semantic memory, and fleet-wide learning (a fix
  learned by one robot/agent propagates to all via sync).

> A robot learns a manipulation/recovery procedure locally → consolidation distills it → it
> syncs to the cloud → it propagates to the whole fleet. Same mechanism that lets one coding
> agent's discovery reach every other agent on the project.

---

## 8. Cortex: the CLI harness (improving on Claude Code)

Thin, deterministic, fast. The intelligence lives in Engram.

1. **Context daemon** — Engram runs as a persistent local service (or in-proc lib). CLI, editor,
   MCP, and subagents share one warm index and code graph. No per-session cold rebuild.
2. **Incremental code graph** — tree-sitter + LSP + symbol graph + embeddings, maintained on
   **file-watch**, not per-session. "Where is X used" is a graph query, not a grep sweep.
3. **Structured tool I/O** — tools return typed results; the engine indexes them and injects only
   what's relevant, instead of pasting raw blobs into the window.
4. **Event-sourced, replayable sessions** — every turn is an event in the DAG. **Fork**,
   **replay**, **time-travel**, and **diff** sessions. Reproducible agent runs; real debugging.
5. **Token budget as a scheduler** — explicit, live allocation across system/rules/code/history/
   tools, with telemetry showing exactly what's consuming the window.
6. **First-class orchestration** — declarative workflows (fan-out / pipeline / verify) over the
   blackboard, with adversarial verification stages, instead of ad-hoc spawning.
7. **Cache-aware, provider-agnostic routing** — route each subtask to the right model/tier;
   assemble prompts cache-aligned; degrade gracefully across providers.
8. **Procedural memory replaces static config** — hooks/permissions/skills/`RULES.md` become
   versioned, testable, *retrievable* procedural records, injected by relevance. Rules that
   never fire don't burn context.
9. **Observability built in** — per turn: tokens, latency, cache-hit rate, retrieval precision/
   recall, cost. You can *see and tune* the context engine.

---

## 9. API surface & the context query language (CXL)

A small, stable API; the cleverness is server-side.

```
# Write (cheap, non-blocking)
engram.remember(event)                       -> id          # append episodic
engram.assert(fact, confidence, provenance)  -> id          # semantic
engram.relate(src, edge, dst)                -> id          # graph edge
engram.pin(rule) / engram.unpin(id)                         # procedural

# Read (the compiler)
engram.compile(task_frame, budget)           -> ContextWindow   # the per-turn money call
engram.query(cxl)                            -> records          # ad-hoc retrieval
engram.recall(handle)                        -> original         # page a summary back in

# Session / multi-agent
engram.fork(session) / engram.replay(session, at)
engram.namespace(scope) ; engram.subscribe(pattern) ; engram.lease(resource)
engram.sync(peer)                                            # Merkle anti-entropy
```

**CXL** (a SQL/GraphQL-ish query for *context assembly*, not just rows) so retrieval policy is
declarative and tunable:

```
COMPILE WINDOW
  BUDGET 12000 tokens
  PIN procedural WHERE applies_to(current_task)
  INCLUDE code FROM graph NEIGHBORHOOD(working_set, hops=2)
  INCLUDE semantic MATCH goal LIMIT BY score
  INCLUDE episodic RECENT 20 WHERE salience > 0.3
  RERANK WITH cross_encoder WHEN budget_pressure > 0.7
  LAYOUT cache_stable
  EMIT diff FROM previous_turn
```

---

## 10. Performance targets (budgets, not vibes)

| Path | Target |
|---|---|
| `compile()` warm, project-scale | p50 < 5 ms, p99 < 25 ms (excl. model) |
| Episodic write | < 100 µs, non-blocking |
| Vector ANN query (edge, quantized) | < 2 ms |
| Edge memory footprint | configurable hard cap (e.g. 256 MB), enforced by ring buffer + quantization |
| Prompt-cache hit rate (stable prefix) | > 80% of prefix tokens cached on follow-up turns |
| Tokens per turn vs. session length | ~flat (differential context), not linear/quadratic |
| Edge→cloud sync | Merkle-diff: bytes ∝ *changes*, not corpus size |

---

## 11. Evaluation harness (you can't tune what you don't measure)

Memory quality is measurable. Ship the eval harness with the engine:

- **Context precision / recall** — of what was packed, how much did the model actually use; of
  what it needed, how much was present. (Trace tool-call arguments back to packed records.)
- **Tokens-to-task-success** — the real efficiency metric: fewer tokens for the same success.
- **Retrieval hit rate** & **rerank lift**.
- **Cache hit rate** and **turn latency** distributions.
- **Task success rate** and **cost per task** on golden traces.
- **Forgetting safety** — assert that summarize-with-pointer never makes a needed fact
  unrecoverable (page-back-in always succeeds).

Run it as a regression gate on golden agent traces, same as a test suite.

---

## 12. Security, tenancy, privacy

- **Scope enforcement at the engine boundary** — RLS-style, every read/write checked against the
  namespace. No app-layer-only gating.
- **Provenance = audit log** — the causal DAG is the audit trail for free.
- **Edge privacy** — raw/PII stays local; only distilled non-PII syncs. Per-record sync policy.
- **Content-addressed integrity** — tamper-evidence via Merkle hashes; verifiable what the agent
  saw.
- **Encryption** — at rest (local + cold), in transit (sync). Per-namespace keys for the cloud.

---

## 13. Reference tech stack

**Engine core**: Rust (one core, both profiles; predictable latency, easy embedding, FFI to
Python/TS/C++ for robot runtimes).

- Embedded KV/relational: `redb`/LMDB/SQLite · Cloud: Postgres
- Episodic columnar: DuckDB/Parquet · Cloud: ClickHouse
- Vector ANN: `usearch`/LanceDB (quantized) · Lexical: tantivy (BM25)
- Graph: in-proc adjacency over KV · Cloud: graph DB or Postgres CTEs
- Sync: custom Merkle anti-entropy (git-pack-style)
- Blob: local FS / object store (S3-compatible)
- Embeddings: small on-device model at edge; batched in cloud

**Cortex CLI**: TypeScript (Ink TUI) or Rust; talks to Engram over a local socket or in-proc.
Provider-agnostic model gateway with cache-aware prompt assembly.

---

## 14. Build roadmap

1. **Episodic core + content addressing** — append-only DAG, dedup, replay. (The substrate.)
2. **Indexes + `compile()` v1** — hybrid retrieval, knapsack pack, cache-aware layout. (The win.)
3. **Differential context + prompt-cache alignment.** (The latency/cost cliff.)
4. **Code graph + structured tools** in Cortex. (Coding-agent quality.)
5. **Consolidation job** — salience, decay, reinforcement, episodic→semantic. (Gets smarter.)
6. **Multi-agent blackboard** — namespaces, lineage, conflict resolution, intent ledger.
7. **Edge profile** — quantization, ring buffer, offline CRDT sync. (Robots.)
8. **Cloud profile** — sharding, multi-tenant, fleet learning. (Scale.)
9. **Eval harness** as a regression gate throughout.

Ship 1–4 and you already beat the status quo on speed and recall; 5–9 are the moat.

---

## 15. Why this is faster — the one-paragraph argument

Speed comes from doing less work on the hot path and never paying for the same context twice.
Engram keeps a **warm, persistent index** (no cold rebuild), answers retrieval **locally**
(no network hop), packs by **value-per-token** instead of top-k (smaller windows), lays out
prompts **cache-stable** (provider cache hits), and sends **only the delta** each turn (flat
cost over long sessions) — while all the expensive learning (consolidation, re-embedding,
conflict resolution) happens **asynchronously off the critical path**. The agent gets a smaller,
sharper window in less time, and gets better at the environment the longer it runs.
