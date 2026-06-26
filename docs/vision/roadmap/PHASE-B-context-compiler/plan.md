# Phase B: Context Compiler — The `compile()` Function

> The core value proposition. Replace ad-hoc context assembly with a cost-based
> query planner that assembles a prompt-cache-aligned, token-budgeted window
> each turn. Ship incrementally: retrieval engines first, packer second,
> layout third, differential last.

---

## Overview

Phase B builds the read path — `engram.compile(taskFrame, budget) → ContextWindow`.
This function makes agents faster and sharper by performing hybrid retrieval across
all memory layers, packing results under a token budget using knapsack optimization
(not top-k), and laying the window out for prompt cache stability.

After this phase, the agent runtime calls `compile()` instead of concatenating
system prompt + history + tools. The agent sees smaller, sharper windows and pays
less in tokens and latency.

**Key changes from original spec (informed by Phase A implementation):**

1. **Embedding pipeline prerequisite** — Phase A writes don't generate embeddings.
   A new Track 0 adds async embedding backfill before vector retrieval is possible.
2. **Always-on architecture** — no feature flags. `compile()` replaces legacy
   context assembly directly. Graceful fallback on error ensures the agent loop
   never breaks.
3. **DuckDB FTS for lexical** — no tantivy-wasm; DuckDB's built-in full-text
   search extension is sufficient and zero-dependency.
4. **Graph retrieval reuses dual-write edges** — Phase A's `:REMEMBERS`/`:ABOUT`
   edges enable direct traversal without generic k-hop.
5. **Compile telemetry** — every `compile()` call logs metrics to ClickHouse for
   tuning fusion weights and validating cache hit targets.
6. **Diff engine deferred to B.1** — ship `compile()` without differential context
   first; add delta optimization once cache hit telemetry validates the approach.

---

## Prerequisites

- **Phase A complete**: Episodic store running, write API integrated, records flowing
- Record format stable (no breaking changes to `MemoryRecord`)
- DuckDB adapter production-ready (local/CLI) and ClickHouse adapter (cloud)
- Neo4j dual-write operational (`:REMEMBERS` + `:ABOUT` edges flowing via Inngest)
- `@oxagen/ai` `embedText()` function available for embedding generation
- Token counting available (check `@oxagen/ai` or add `tiktoken`/`@anthropic-ai/tokenizer`)

---

## Track Execution Order

Unlike Phase A (4 parallel tracks), Phase B tracks have dependencies:

```
Track 0: Embedding Pipeline  ←── prerequisite for Track 1 vector retrieval
    │
    ├──► Track 1a: Temporal Retrieval    (no deps, works immediately)
    ├──► Track 1b: Graph Retrieval       (no deps, uses existing Neo4j edges)
    ├──► Track 1c: Vector Retrieval      (needs Track 0 embeddings)
    ├──► Track 1d: Lexical Retrieval     (needs DuckDB FTS extension)
    │
    └──► Track 1e: Fusion Combiner       (needs at least 2 engines)
              │
              ▼
         Track 2: Packer                  (needs fusion output)
              │
              ▼
         Track 3: Layout + Integration    (needs packed result)
              │
              ▼
         Track 4: Telemetry + UI          (needs compile() running)
```

**Parallelism:** Tracks 1a–1d can start simultaneously. Track 0 and Track 1a/1b
can also start in parallel since temporal and graph retrieval don't need embeddings.

---

## Track 0: Embedding Pipeline (Prerequisite)

**Goal**: Generate embeddings for every Engram record asynchronously so vector
retrieval has data to work with from day one.

**Deliverables**:

- `packages/engram/src/embed/pipeline.ts` — Embedding generation logic
- Inngest event: `engram/memory.embed` in event registry
- Inngest function: `engram.embed-memory` worker
- Backfill script for existing records without embeddings

**Architecture**:

The embedding pipeline follows the same async pattern as the graph sync:

1. Record written to episodic store (synchronous, < 100µs)
2. `engram/memory.embed` Inngest event fired (async, best-effort)
3. Worker generates embedding via `@oxagen/ai` `embedText()`
4. Embedding stored back on the record (DuckDB UPDATE or ClickHouse insert)

This means vector retrieval has a ~1-2s delay after a write before the record
becomes vector-searchable. Temporal, graph, and lexical retrieval are immediate.

```typescript
// packages/engram/src/embed/pipeline.ts

export interface EmbedResult {
  recordId: string;
  embedding: number[]; // Full float32 for Neo4j ANN index
  quantized: Int8Array; // Int8 for storage/edge deployment
}

export async function embedRecord(
  recordId: string,
  bodyText: string,
  opts: { orgId: string; workspaceId: string; surface: string },
): Promise<EmbedResult> {
  const embedding = await embedText(bodyText, {
    telemetry: {
      orgId: opts.orgId,
      workspaceId: opts.workspaceId,
      surface: opts.surface,
    },
  });
  const quantized = quantizeToInt8(embedding);
  return { recordId, embedding, quantized };
}
```

**Backfill strategy**:

- On first Phase B deploy, run a one-time backfill script that queries all
  records without embeddings and enqueues embed events
- Inngest's concurrency limits prevent overwhelming the embedding API
- Records written after deploy get embedded automatically

**Tests**:

- Embedding worker produces valid float32 vectors
- Quantization preserves cosine similarity within 2% tolerance
- Backfill script is idempotent (re-running doesn't re-embed)

**Estimated effort**: 3–4 days

---

## Track 1: Retrieval Engines

**Goal**: Implement four retrieval modalities that each return scored candidates,
plus a fusion combiner that merges them into a single ranked list.

### Shared Types

```typescript
// packages/engram/src/retrieval/types.ts

export interface RetrievalCandidate {
  record: MemoryRecord;
  score: number; // Normalized 0.0–1.0
  source: "vector" | "lexical" | "graph" | "temporal" | "pinned";
  tokenCost: number; // Estimated tokens if included verbatim
}

export interface RetrievalEngine {
  name: string;
  retrieve(query: RetrievalQuery): Promise<RetrievalCandidate[]>;
}

export interface RetrievalQuery {
  namespace: Namespace;
  taskDescription: string; // Natural language goal
  workingSet: string[]; // Currently active file/symbol/entity IDs
  recentEventIds: string[]; // Last N episodic event record IDs
  limit: number; // Max candidates per engine
}

export interface TaskFrame {
  namespace: Namespace;
  taskDescription: string;
  workingSet: string[];
  recentEventIds: string[];
  modelId: string; // Determines tokenizer + budget
  previousWindowHash?: string; // For cache-stability computation
  sessionId?: string;
  agentId?: string;
}
```

---

### Track 1a: Temporal Retrieval

**File**: `packages/engram/src/retrieval/temporal.ts`

**Strategy**: Recent episodic events weighted by exponential recency decay.
Works immediately with the existing DuckDB store — no new infrastructure.

```typescript
score = (salience * e) ^ ((-λ * (now - createdAt)) / ONE_HOUR);
// λ = 0.1 → half-life ~7 hours
```

**Implementation**:

- Query `store.recent(namespace, limit: 50, minSalience: 0.2)`
- Apply exponential decay to each record's score
- Return top candidates sorted by decayed score

**Why this ships first**: Zero new deps. Uses the existing episodic store query
API from Phase A. Provides baseline retrieval quality on day one.

---

### Track 1b: Graph Retrieval

**File**: `packages/engram/src/retrieval/graph.ts`

**Strategy**: Starting from `workingSet` entity IDs, traverse the `:REMEMBERS`
and `:ABOUT` edges that Phase A's dual-write creates. Returns memories that are
structurally related to the current working context.

```cypher
// Direct retrieval: "what memories are attached to these entities?"
MATCH (entity)-[:REMEMBERS]->(m:EngramMemory)
WHERE entity.id IN $workingSet AND entity.orgId = $orgId
RETURN m.recordId AS recordId, m.salience AS salience, m.kind AS kind
UNION
MATCH (m:EngramMemory)-[:ABOUT]->(kn:KnowledgeNode)
WHERE kn.publicId IN $workingSet AND kn.orgId = $orgId
RETURN m.recordId AS recordId, m.salience AS salience, m.kind AS kind
ORDER BY salience DESC
LIMIT $limit
```

Then look up the full records from the episodic store by their IDs.

**Why this is powerful**: Answers "what does the agent know about these files?"
in a single graph hop rather than searching the entire corpus. Phase A's
dual-write investment pays off here.

---

### Track 1c: Vector Retrieval

**File**: `packages/engram/src/retrieval/vector.ts`

**Strategy**: Embed the `taskDescription`, then ANN search against the Neo4j
vector index (`memory_embedding_index`) + DuckDB vector extension for local.

**Prerequisites**: Track 0 must be running so records have embeddings.

**Implementation**:

- Embed `taskDescription` via `@oxagen/ai` `embedText()`
- Query Neo4j: `CALL db.index.vector.queryNodes('memory_embedding_index', $limit, $embedding)`
- Filter by namespace (orgId + workspaceId in WHERE clause)
- Score = cosine similarity from the ANN query

**Fallback**: If a record doesn't have an embedding yet (just written, embed
worker hasn't run), it won't appear in vector results but WILL appear via
temporal or graph retrieval. No blind spots.

---

### Track 1d: Lexical Retrieval (DuckDB FTS)

**File**: `packages/engram/src/retrieval/lexical.ts`

**Strategy**: BM25 full-text search over record bodies using DuckDB's built-in
`fts` extension. Critical for exact matches that vectors miss — error messages,
function names, file paths, stack traces.

**Implementation**:

```sql
-- One-time setup (run in DuckDB adapter initialization)
INSTALL fts;
LOAD fts;
PRAGMA create_fts_index('episodic_records', 'id', 'body');

-- Query
SELECT id, body, fts_main_episodic_records.match_bm25(id, ?) AS bm25_score
FROM episodic_records
WHERE namespace_org = ? AND namespace_workspace = ?
  AND bm25_score IS NOT NULL
ORDER BY bm25_score DESC
LIMIT ?
```

**Why DuckDB FTS instead of tantivy-wasm**:

- Zero new dependencies (DuckDB is already installed)
- Automatically maintained (no separate index process)
- Same query path as all other DuckDB operations
- Performance: DuckDB FTS is fast enough for project-scale corpora (<5ms)

**ClickHouse equivalent**: ClickHouse has built-in full-text indexing via
`ngramBF` or `tokenbf_v1` — use these for the cloud adapter.

---

### Track 1e: Reciprocal Rank Fusion

**File**: `packages/engram/src/retrieval/fusion.ts`

**Strategy**: Merge results from all engines using RRF, then apply a weighted
combination that balances relevance, recency, salience, and token efficiency.

```typescript
// Standard RRF with k=60
function rrf(rankings: Map<string, number>[]): Map<string, number> {
  const k = 60;
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [id, rank] of ranking) {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  return fused;
}

// Final score combines multiple signals
finalScore =
  w_rel * rrfScore +
  w_rec * recencyDecay +
  w_imp * salience +
  w_out * outcomeBoost -
  w_tok * normalizedTokenCost;
```

**Initial weights** (uniform, tuned by Phase D reinforcement):

- `w_rel = 0.35` (relevance from fusion)
- `w_rec = 0.25` (recency)
- `w_imp = 0.20` (salience)
- `w_out = 0.10` (outcome boost for success/failure)
- `w_tok = 0.10` (penalty for expensive records)

**Dedup**: Same record from multiple engines → merge scores, don't double-count.

**Tests**:

- Fusion of 4 engines produces better recall than any single engine
- Same record from multiple sources has higher score than single-source
- Namespace isolation (no cross-tenant leakage through any engine)
- Performance: all engines run in parallel, fusion < 2ms

**Estimated effort (all of Track 1)**: 8–10 days

---

## Track 2: Packing Algorithm

**Goal**: Budget-constrained knapsack packing that maximizes task-value per token.

**Deliverables**:

- `packages/engram/src/compiler/packer.ts` — Knapsack optimizer
- `packages/engram/src/compiler/tokenizer.ts` — Model-aware token counting
- `packages/engram/src/compiler/compress.ts` — Compression for cold items

### Token Counting

```typescript
// packages/engram/src/compiler/tokenizer.ts

export interface Tokenizer {
  count(text: string): number;
  modelFamily: "openai" | "anthropic";
}

// Model-aware: uses @oxagen/ai's model registry to select the right tokenizer
export function getTokenizer(modelId: string): Tokenizer;
```

**Implementation note**: Check if `@oxagen/ai` already exposes token counting.
If not, add `tiktoken` for OpenAI family (cl100k_base, o200k_base) and
`@anthropic-ai/tokenizer` for Claude family. Cache tokenizer instances per model.

### Packing

```typescript
// packages/engram/src/compiler/packer.ts

export interface PackerInput {
  candidates: RetrievalCandidate[]; // Sorted by fused score
  budget: TokenBudget;
  pinnedRecords: MemoryRecord[]; // Always included (salience=1.0 procedural)
  diversityConstraint: number; // Max N records from same source/cluster
}

export interface TokenBudget {
  total: number;
  reserved: {
    system: number; // System prompt (fixed cost)
    procedural: number; // Pinned rules (query: minSalience=1.0, kind=procedural)
    volatile: number; // Available for retrieved content
    working: number; // Recent episodic events (scratchpad)
  };
}

export interface PackResult {
  included: MemoryRecord[]; // Full-text inclusion
  compressed: CompressedItem[]; // Summary + retrieval handle
  evicted: MemoryRecord[]; // Didn't make the cut
  tokenUsage: TokenUsage;
}

export interface CompressedItem {
  recordId: string; // For engram.recall() page-back-in
  summary: string; // First sentence or auto-summary, ≤50 tokens
  score: number; // Original fused score (for ordering)
  tokenCost: number;
}
```

**Algorithm** (greedy knapsack with diversity constraint):

1. **Reserve**: Subtract pinned procedural rules (always included, salience=1.0)
   - Query: `store.query({ namespace, minSalience: 1.0, kinds: ["procedural"], limit: 50 })`
   - These already exist from `engram.pin()` — no new API needed
2. **Reserve**: Subtract working memory budget (last N episodic events)
3. **Sort**: Remaining candidates by `value_per_token = fusedScore / tokenCost`
4. **Pack greedily**: Include candidates in vpt order until budget exhausted
5. **Diversity gate**: Skip if > N records share the same `provenance.tool` or
   `body.domain` (prevents one noisy tool from dominating)
6. **Compress**: Items above a relevance floor but below the pack line get a
   one-line summary + retrieval handle (costs ~50 tokens, preserves discoverability)
7. **Evict**: Everything else

**Tests**:

- Budget never exceeded (property test: ∀ inputs, tokenUsage.total ≤ budget.total)
- Higher-vpt records always preferred over lower-vpt
- Pinned records always present regardless of budget pressure
- Diversity constraint prevents >N records from same source
- Empty candidates → valid empty PackResult (no crash)

**Estimated effort**: 5–7 days

---

## Track 3: Layout + Integration

**Goal**: Arrange packed content into a cache-stable prompt layout, wire `compile()`
into the agent runtime as a progressive replacement for legacy context assembly.

### Cache-Aware Layout

```typescript
// packages/engram/src/compiler/layout.ts

export interface ContextWindow {
  sections: ContextSection[];
  tokenUsage: TokenUsage;
  cachePrefix: {
    stableBytes: number; // Bytes identical to previous turn
    totalBytes: number;
    hitRate: number; // stableBytes / totalBytes — target > 60%
  };
  metadata: CompileMetadata;
}

export interface ContextSection {
  id: string;
  type: SectionType;
  content: string;
  tokens: number;
  stable: boolean; // true = doesn't change between turns
  position: number; // Lower = earlier in prompt (stable first)
}

export type SectionType =
  | "system" // Position 0 — system prompt (always stable)
  | "procedural" // Position 1 — pinned rules (mostly stable)
  | "project-facts" // Position 2 — semantic memory (semi-stable)
  | "code-skeleton" // Position 3 — code graph context (semi-stable)
  | "retrieved" // Position 4 — task-specific retrieved (volatile)
  | "tool-results" // Position 5 — recent tool outputs (volatile)
  | "working"; // Position 6 — working memory / scratchpad (volatile)
```

**Layout rules**:

1. Sections ordered by position — stable first, volatile last
2. Within stable sections: deterministic sort (alphabetical by record ID)
3. Stable sections are byte-identical across turns when content doesn't change
4. Cache hit rate = (stable prefix bytes) / (total bytes) — target > 60%
5. System prompt + procedural rules alone typically give 40%+ prefix stability

### Agent Runtime Integration

```typescript
// packages/agent/src/runtime/context-compiler.ts

export async function buildAgentContext(
  ctx: CapabilityContext,
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  // compile() is the primary context path. If it fails for any reason,
  // fall back to legacy assembly so the agent loop never breaks.
  try {
    const taskFrame = buildTaskFrame(ctx, messages);
    const budget = computeBudget(ctx.modelId);
    const window = await compile(taskFrame, budget);
    return windowToMessages(window, messages);
  } catch {
    // Graceful degradation — compile() errors never break the agent
    return buildLegacyContext(ctx, messages);
  }
}
```

`compile()` is always-on. There is no feature flag, no shadow mode, no phased
rollout. The legacy context path exists only as a catch handler for unexpected
errors — it is never the intended path. Every agent turn goes through the
compiler from day one.

### TaskFrame Builder

```typescript
// packages/agent/src/runtime/task-frame.ts

export function buildTaskFrame(
  ctx: CapabilityContext,
  messages: ModelMessage[],
): TaskFrame {
  return {
    namespace: { org: ctx.orgId, workspace: ctx.workspaceId },
    taskDescription: extractTaskDescription(messages),
    workingSet: extractWorkingSet(ctx), // Open files, recent tool targets
    recentEventIds: [], // Filled by store.recent()
    modelId: ctx.modelId ?? "default",
    previousWindowHash: ctx.previousWindowHash,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
  };
}
```

**Tests**:

- `compile()` produces valid ContextWindow with all required fields
- Cache hit rate > 60% on a 5-turn conversation test
- Section ordering is deterministic (same input → same layout)
- System prompt always at position 0
- Graceful fallback: compile error → legacy context, no agent disruption
- Performance: total compile < 50ms (p99) on project-scale corpus

**Estimated effort**: 6–8 days

---

## Track 4: Telemetry + Memories UI Extension

**Goal**: Observability for compile() — log every invocation to ClickHouse, and
extend the memories UI to show what the compiler selected per turn.

### Compile Telemetry

**File**: `packages/engram/src/compiler/telemetry.ts`

Every `compile()` call emits a structured event to ClickHouse:

```typescript
export interface CompileTelemetryEvent {
  compile_id: string; // UUID per invocation
  org_id: string;
  workspace_id: string;
  session_id: string | null;
  agent_id: string | null;
  model_id: string;

  // Performance
  retrieval_ms: number;
  packing_ms: number;
  layout_ms: number;
  total_ms: number;

  // Volume
  candidates_retrieved: number;
  candidates_packed: number;
  candidates_compressed: number;
  candidates_evicted: number;

  // Budget
  budget_total: number;
  budget_used: number;
  budget_remaining: number;

  // Cache
  cache_stable_bytes: number;
  cache_total_bytes: number;
  cache_hit_rate: number;

  // Retrieval breakdown
  vector_candidates: number;
  lexical_candidates: number;
  graph_candidates: number;
  temporal_candidates: number;

  created_at: string; // ISO-8601
}
```

**ClickHouse table**: `engram_compile_telemetry` (MergeTree, partitioned by org + month).

This data enables:

- Dashboard showing compile latency percentiles over time
- Cache hit rate trends (validates the 60% target)
- Retrieval engine contribution (which engines are pulling their weight)
- Budget utilization (are we wasting context window or packing too tight)
- Per-model comparison (does compile work better for some models)

### Memories UI: Compile Inspector

Extend the existing memories UI (`apps/app/src/components/knowledge/memories/`)
with a "Compile History" view:

- **Timeline** of recent compile() invocations for this workspace
- **Per-compile detail**: which records were included, compressed, or evicted
- **Score breakdown**: why each record was selected (show fusion score components)
- **Budget visualization**: stacked bar showing system/procedural/retrieved/working allocation
- **Cache stability indicator**: hit rate trend over recent turns

This closes the observability loop: write memories → see what the agent uses.

**Tests**:

- Telemetry event emitted on every compile() call
- All numeric fields are non-negative
- Cache hit rate computed correctly (stable/total)
- UI renders without errors for empty compile history

**Estimated effort**: 4–5 days

---

## Phase B.1: Differential Context (Deferred)

> Shipped after Phase B core is validated with telemetry data.

**Goal**: Compute a minimal delta between consecutive compile() windows so
providers that support cache continuation get maximum reuse.

**Prerequisites**:

- Phase B core running in production
- Compile telemetry showing actual cache hit rates
- At least 2 weeks of production data to validate stable prefix approach

**Deliverables**:

- `packages/engram/src/compiler/diff.ts` — Delta computation
- Provider-specific delta encoding (Anthropic prompt caching, OpenAI conversation continuation)

**Why deferred**: The cache-stable prefix layout already achieves 60%+ hit rates
without any diff engine. The diff optimization adds significant complexity
(section patching, provider compatibility) for diminishing returns. Ship it only
after telemetry validates that we need the extra 10-20% improvement.

---

## Deliverables Checklist

- [ ] Embedding pipeline (Track 0): async embed worker + backfill script
- [ ] Temporal retrieval engine
- [ ] Graph retrieval engine (using Phase A dual-write edges)
- [ ] Vector retrieval engine (ANN over Neo4j index)
- [ ] Lexical retrieval engine (DuckDB FTS / ClickHouse tokenbf)
- [ ] Reciprocal Rank Fusion combiner
- [ ] Knapsack packer with budget enforcement and diversity constraint
- [ ] Model-aware token counting
- [ ] Cache-aware layout with stable prefix ordering
- [ ] `compile(taskFrame, budget) → ContextWindow` orchestrator function
- [ ] Agent runtime integration (always-on, graceful error fallback)
- [ ] TaskFrame builder from CapabilityContext + messages
- [ ] Compile telemetry to ClickHouse
- [ ] Memories UI: compile inspector view
- [ ] Performance benchmarks in CI (p50 < 10ms, p99 < 50ms)

---

## Success Criteria

| Metric                                    | Target                                          |
| ----------------------------------------- | ----------------------------------------------- |
| `compile()` latency (warm, project-scale) | p50 < 10ms, p99 < 50ms                          |
| Prompt cache hit rate (follow-up turns)   | > 60% stable prefix                             |
| Retrieval precision (golden test set)     | > 70%                                           |
| Budget compliance                         | 100% (never exceeds budget)                     |
| Agent regression                          | Zero failures with compile() active             |
| Embedding coverage                        | > 95% of records embedded within 60s of write   |
| Error fallback                            | compile() error → legacy context, no disruption |
| Telemetry coverage                        | 100% of compile() calls logged to ClickHouse    |

---

## Dependencies

| Depends On | Details                                                 |
| ---------- | ------------------------------------------------------- |
| Phase A    | Episodic store running, write API emitting records      |
| Phase A    | Neo4j dual-write edges (`:REMEMBERS`, `:ABOUT`) flowing |
| Phase A    | Record format stable (MemoryRecord types)               |

| Depended On By | Details                                                   |
| -------------- | --------------------------------------------------------- |
| Phase C        | Cortex daemon calls `compile()` for every CLI turn        |
| Phase D        | Consolidation improves retrieval quality over time        |
| Phase D        | Reinforcement tunes fusion weights from compile telemetry |
| Phase E        | Multi-agent blackboard extends retrieval scope            |

---

## Risks & Mitigations

| Risk                                                   | Likelihood | Impact | Mitigation                                                                          |
| ------------------------------------------------------ | ---------- | ------ | ----------------------------------------------------------------------------------- |
| Embedding pipeline latency spikes                      | Medium     | Medium | Inngest concurrency limits; batch embeddings; monitor queue depth                   |
| DuckDB FTS extension not available in all environments | Low        | Medium | Graceful skip: if FTS load fails, lexical engine returns empty (fusion still works) |
| Neo4j vector search too slow (> 20ms per query)        | Medium     | High   | Add `usearch` local index; Neo4j becomes warm tier, local becomes hot tier          |
| Token counting mismatch (estimated ≠ actual)           | Medium     | Medium | 5% safety margin on budget; validate against provider token counts                  |
| Fusion weights produce poor results                    | High       | Medium | Start uniform; Phase D reinforcement; compile telemetry tracks precision            |
| Compile() too slow (> 50ms p99)                        | Medium     | High   | Run engines in parallel; pre-warm indexes; add circuit breaker (timeout → fallback) |
| Graph retrieval returns stale :REMEMBERS edges         | Low        | Low    | Edges are eventually consistent via Inngest; 99%+ arrive within 30s                 |

---

## Files Created / Modified

### Created

| File                                                              | Purpose                            |
| ----------------------------------------------------------------- | ---------------------------------- |
| `packages/engram/src/embed/pipeline.ts`                           | Embedding generation logic         |
| `packages/engram/src/embed/quantize.ts`                           | Float32 → Int8 quantization        |
| `packages/engram/src/retrieval/types.ts`                          | Shared retrieval types + TaskFrame |
| `packages/engram/src/retrieval/temporal.ts`                       | Recency-weighted retrieval         |
| `packages/engram/src/retrieval/graph.ts`                          | Neo4j edge-based retrieval         |
| `packages/engram/src/retrieval/vector.ts`                         | ANN similarity retrieval           |
| `packages/engram/src/retrieval/lexical.ts`                        | DuckDB FTS / BM25 retrieval        |
| `packages/engram/src/retrieval/fusion.ts`                         | RRF combiner                       |
| `packages/engram/src/compiler/compile.ts`                         | Top-level orchestrator             |
| `packages/engram/src/compiler/packer.ts`                          | Knapsack budget packer             |
| `packages/engram/src/compiler/tokenizer.ts`                       | Model-aware token counting         |
| `packages/engram/src/compiler/compress.ts`                        | Summary compression                |
| `packages/engram/src/compiler/layout.ts`                          | Cache-aware section layout         |
| `packages/engram/src/compiler/sections.ts`                        | Section type definitions           |
| `packages/engram/src/compiler/telemetry.ts`                       | Compile telemetry emitter          |
| `packages/inngest-functions/src/functions/engram.embed-memory.ts` | Embed worker                       |

### Modified

| File                                                             | Change                                 |
| ---------------------------------------------------------------- | -------------------------------------- |
| `packages/inngest-functions/src/inngest.ts`                      | Add `engram/memory.embed` event        |
| `packages/inngest-functions/src/functions.ts`                    | Register embed worker                  |
| `packages/engram/src/index.ts`                                   | Export compile(), retrieval, TaskFrame |
| `packages/agent/src/runtime/context-compiler.ts`                 | New: compile integration               |
| `packages/agent/src/runtime/task-frame.ts`                       | New: TaskFrame builder                 |
| `packages/agent/src/runtime/engram-writer.ts`                    | Fire embed event after write           |
| `apps/app/src/components/knowledge/memories/memories-client.tsx` | Add compile inspector                  |

---

## Timeline (Aggressive)

```
Week:  1     2     3     4     5     6
       ├─────┤
       Track 0: Embedding Pipeline
       ├───────────────────┤
       Track 1: Retrieval Engines (parallel: temporal+graph immediately, vector+lexical after Track 0)
                   ├─────────────┤
                   Track 2: Packer (starts after fusion combiner)
                         ├─────────────┤
                         Track 3: Layout + Integration
                               ├───────┤
                               Track 4: Telemetry + UI
                                        │
                                        └── Phase B.1 (diff engine) — deferred, data-driven decision
```

**Total estimated duration: 5–6 weeks** (slightly ahead of original 4–6 week estimate
due to parallelism between Track 0 and Track 1a/1b, and elimination of diff engine
from the critical path).
