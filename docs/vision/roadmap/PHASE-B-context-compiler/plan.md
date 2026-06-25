# Phase B: Context Compiler — The `compile()` Function

> The core value proposition. Replace ad-hoc context assembly with a cost-based query
> planner that assembles a prompt-cache-aligned, token-budgeted window each turn.

---

## Overview

Phase B builds the read path — the `engram.compile(taskFrame, budget) → ContextWindow` function. This is the function that makes agents faster and sharper. It performs hybrid retrieval across all memory layers, packs results under a token budget using knapsack optimization (not top-k), lays the window out for prompt cache stability, and optionally computes a differential delta from the previous turn.

After this phase, the agent runtime calls `compile()` instead of concatenating system prompt + history + tools. The agent sees smaller, sharper windows and pays less in tokens and latency.

---

## Prerequisites

- **Phase A complete**: Episodic store running, write API integrated, records flowing
- Record format stable (no breaking changes to `MemoryRecord`)
- At least one store adapter production-ready (DuckDB local or ClickHouse cloud)
- Neo4j vector index operational (existing `memory_embedding_index`)
- Skills loaded with embeddings (pre-computed at registry load time)
- Token counting library selected (e.g., `tiktoken` for OpenAI, `@anthropic-ai/tokenizer`)

---

## Parallel Tracks

### Track 1: Retrieval Engines (Agent 1)

**Goal**: Implement four parallel retrieval modalities that each return scored candidates from different angles.

**Deliverables**:
- `packages/engram/src/retrieval/vector.ts` — ANN similarity search
- `packages/engram/src/retrieval/lexical.ts` — BM25 exact match (symbols, identifiers, error strings)
- `packages/engram/src/retrieval/graph.ts` — k-hop neighborhood from working set
- `packages/engram/src/retrieval/temporal.ts` — Recency-weighted recall
- `packages/engram/src/retrieval/fusion.ts` — Reciprocal Rank Fusion combiner

**Implementation**:

```typescript
// packages/engram/src/retrieval/types.ts

export interface RetrievalCandidate {
  record: MemoryRecord;
  score: number;           // Normalized 0.0–1.0
  source: "vector" | "lexical" | "graph" | "temporal" | "pinned";
  tokenCost: number;       // Estimated tokens if included verbatim
}

export interface RetrievalEngine {
  name: string;
  retrieve(query: RetrievalQuery): Promise<RetrievalCandidate[]>;
}

export interface RetrievalQuery {
  namespace: Namespace;
  taskDescription: string;     // Natural language goal
  workingSet: string[];         // Currently active file/symbol/entity IDs
  recentEventIds: string[];     // Last N episodic events (for context)
  limit: number;                // Max candidates per engine
}
```

**Vector retrieval** (`vector.ts`):
- Embeds `taskDescription` via the existing `packages/ai/src/embed.ts` `embedText()` function
- Queries Neo4j vector index (`memory_embedding_index`) + DuckDB vector extension
- Returns top-k by cosine similarity
- Filters by namespace (RLS)

**Lexical retrieval** (`lexical.ts`):
- BM25 scoring over record bodies
- Targets: code symbols, error messages, file paths, identifiers
- Implementation: In-memory inverted index built from warm records (or tantivy-wasm)
- Critical for exact matches that vectors miss ("TypeError: cannot read property 'foo'")

**Graph retrieval** (`graph.ts`):
- Starting from `workingSet` entity IDs, traverse k hops (default: 2)
- Uses Neo4j Cypher queries against the existing ontology graph
- Returns entities reachable from the current working context
- Edge types from `packages/ontology/src/types.ts` (CONTAINS, REFERENCES, IMPLEMENTS, etc.)

**Temporal retrieval** (`temporal.ts`):
- Recent episodic events weighted by recency decay
- Exponential decay: `score = e^(-λ * (now - createdAt))`
- Filters by minimum salience threshold (skip noise)
- Source: DuckDB/ClickHouse episodic store

**Fusion** (`fusion.ts`):
- Reciprocal Rank Fusion (RRF) across all engine results
- `RRF_score(d) = Σ 1/(k + rank_i(d))` where k=60 (standard)
- Then weighted combination: `final = w_rel·relevance + w_rec·recency + w_imp·salience + w_out·outcome − w_tok·token_cost`
- Dedup by record ID (same record from multiple engines merged, scores combined)
- Returns sorted candidates for the packer

**Tests**:
- Each engine returns scored candidates for a test corpus
- Fusion produces better recall than any single engine alone
- Namespace filtering works (no cross-tenant leakage)
- Performance: all four engines run in parallel (Promise.all), total < 10ms warm

**Estimated effort**: 7–9 days

---

### Track 2: Packing Algorithm (Agent 2)

**Goal**: Implement budget-constrained knapsack packing that maximizes task-value per token.

**Deliverables**:
- `packages/engram/src/compiler/packer.ts` — Knapsack optimizer
- `packages/engram/src/compiler/tokenizer.ts` — Token counting wrapper
- `packages/engram/src/compiler/compress.ts` — Compression strategies for cold items

**Implementation**:

```typescript
// packages/engram/src/compiler/packer.ts

export interface PackerInput {
  candidates: RetrievalCandidate[];  // Sorted by fused score
  budget: TokenBudget;
  pinnedRecords: MemoryRecord[];     // Always included (procedural rules)
  diversityConstraint: number;        // Max N records from same source/cluster
}

export interface TokenBudget {
  total: number;           // Total token budget for the window
  reserved: {
    system: number;        // System prompt (fixed)
    procedural: number;    // Pinned rules (semi-fixed)
    volatile: number;      // Available for retrieved content
    working: number;       // Working memory / recent events
  };
}

export interface PackResult {
  verbatim: MemoryRecord[];       // Included full text (hot, relevant)
  compressed: CompressedItem[];    // Included as summary + handle (cold, supporting)
  evicted: MemoryRecord[];         // Didn't fit (too expensive for their value)
  tokenUsage: TokenUsage;
}

export interface CompressedItem {
  summary: string;          // Short summary of the record
  handle: string;           // Record ID for page-back-in via engram.recall()
  tokenCost: number;        // Tokens used by the summary
}

export interface TokenUsage {
  system: number;
  procedural: number;
  volatile: number;
  working: number;
  total: number;
  budgetRemaining: number;
}
```

**Packing algorithm** (greedy knapsack with diversity):
1. Reserve budget for pinned procedural rules (always included)
2. Reserve budget for working memory (recent N events, always included)
3. Sort remaining candidates by `value_per_token = fused_score / token_cost`
4. Greedily pack in value-per-token order until budget exhausted
5. Apply diversity constraint: skip if > N records from same cluster
6. Items below a score threshold get compressed (summary + handle) at lower token cost
7. Items that don't fit at all are evicted

**Compression strategy**:
- For evicted items above a minimum relevance: generate a one-line summary + retrieval handle
- Summary is: first sentence of body, truncated to 50 tokens
- Handle enables `engram.recall(handle)` to page the full record back in later
- Summaries cost tokens but preserve discoverability

**Token counting**:
- Use `tiktoken` for OpenAI models (cl100k_base)
- Use `@anthropic-ai/tokenizer` for Claude models
- Cache token counts on records (compute once, store as property)

**Tests**:
- Packing never exceeds budget (property test: ∀ inputs, total ≤ budget)
- Higher-value records are preferred over lower-value records
- Diversity constraint prevents N+1 records from same source
- Pinned records always present regardless of budget pressure
- Compressed items include valid retrieval handles

**Estimated effort**: 5–7 days

---

### Track 3: Layout Optimizer (Agent 3)

**Goal**: Arrange the packed content into a cache-stable prompt layout where the prefix is byte-identical across turns.

**Deliverables**:
- `packages/engram/src/compiler/layout.ts` — Cache-aware section arranger
- `packages/engram/src/compiler/diff.ts` — Differential context computation
- `packages/engram/src/compiler/sections.ts` — Section type definitions

**Implementation**:

```typescript
// packages/engram/src/compiler/layout.ts

export interface ContextWindow {
  sections: ContextSection[];
  tokenUsage: TokenUsage;
  cachePrefix: {
    stableBytes: number;     // Bytes that are identical to previous turn
    totalBytes: number;      // Total window size
    hitRate: number;         // stableBytes / totalBytes
  };
  metadata: {
    compiledAt: number;
    retrievalMs: number;
    packingMs: number;
    layoutMs: number;
    totalMs: number;
  };
}

export interface ContextSection {
  id: string;
  type: SectionType;
  content: string;
  tokens: number;
  stable: boolean;          // true = doesn't change between turns (prefix-safe)
  position: number;         // Ordering rank (lower = earlier in prompt)
}

export type SectionType =
  | "system"               // System prompt (position 0, always stable)
  | "procedural"           // Pinned rules and skills (position 1, mostly stable)
  | "project-facts"        // Stable semantic memory about the project (position 2)
  | "code-skeleton"        // Code graph structure (position 3, semi-stable)
  | "retrieved"            // Task-specific retrieved content (position 4, volatile)
  | "tool-results"         // Recent structured tool outputs (position 5, volatile)
  | "working"              // Working memory — recent events, scratchpad (position 6)
  ;
```

**Layout rules**:
1. Sections are ordered by `position` — stable sections first, volatile last
2. Stable sections are byte-identical across turns (system prompt, procedural rules, project facts)
3. Volatile sections (retrieved content, working memory) change every turn but only at the tail
4. Within stable sections, content is sorted deterministically (alphabetical, by ID, etc.)
5. Cache hit rate = (bytes in stable prefix) / (total bytes). Target: > 60%.

**Differential context** (`diff.ts`):

```typescript
export interface ContextDiff {
  previousTurnId: string;
  additions: ContextSection[];     // New sections to add
  removals: string[];              // Section IDs to remove
  modifications: SectionPatch[];   // Patches to existing sections
  deltaTokens: number;            // Net token change
}

export interface SectionPatch {
  sectionId: string;
  operation: "append" | "replace_tail" | "truncate";
  content: string;
  tokens: number;
}
```

The diff engine:
1. Compares current `compile()` output to the previous turn's window
2. Stable sections: no-op (already in the provider's cache)
3. Volatile sections: compute add/remove/patch operations
4. Emit the minimal delta that transforms the previous window into the current one
5. For providers that support it: send only the delta (conversation continuation)
6. Fallback: emit full window but ensure stable prefix for cache hits

**Tests**:
- Consecutive `compile()` calls produce windows with identical prefixes
- Cache hit rate > 60% on a multi-turn conversation test
- Diff correctly identifies additions and removals
- Section ordering is deterministic (same input → same layout)
- System prompt never moves from position 0

**Estimated effort**: 5–7 days

---

### Track 4: Integration (Agent 4)

**Goal**: Wire `compile()` into `packages/agent/src/runtime` as an opt-in replacement for current context assembly.

**Deliverables**:
- `packages/engram/src/compiler/compile.ts` — Top-level orchestrator
- `packages/agent/src/runtime/context-compiler.ts` — Agent runtime integration
- `packages/agent/src/runtime/task-frame.ts` — Task frame builder from current state

**Implementation**:

```typescript
// packages/engram/src/compiler/compile.ts

export async function compile(taskFrame: TaskFrame, budget: TokenBudget): Promise<ContextWindow> {
  const startMs = Date.now();

  // 1. Build retrieval query from task frame
  const query = buildRetrievalQuery(taskFrame);

  // 2. Run all retrieval engines in parallel
  const retrievalStart = Date.now();
  const candidates = await runRetrievalEngines(query);
  const retrievalMs = Date.now() - retrievalStart;

  // 3. Fuse and rank
  const fused = fuseAndRank(candidates);

  // 4. Get pinned procedural records
  const pinned = await getPinnedRecords(taskFrame.namespace);

  // 5. Pack under budget
  const packStart = Date.now();
  const packed = pack({ candidates: fused, budget, pinnedRecords: pinned, diversityConstraint: 3 });
  const packingMs = Date.now() - packStart;

  // 6. Layout for cache stability
  const layoutStart = Date.now();
  const window = layout(packed, taskFrame);
  const layoutMs = Date.now() - layoutStart;

  return {
    ...window,
    metadata: {
      compiledAt: Date.now(),
      retrievalMs,
      packingMs,
      layoutMs,
      totalMs: Date.now() - startMs,
    },
  };
}
```

**Agent runtime integration**:

```typescript
// packages/agent/src/runtime/context-compiler.ts

const CONTEXT_COMPILER_ENABLED = process.env.ENGRAM_COMPILE_ENABLED === "true";

export async function buildAgentContext(ctx: CapabilityContext, messages: ModelMessage[]): Promise<ModelMessage[]> {
  if (!CONTEXT_COMPILER_ENABLED) {
    // Fallback: existing behavior (system prompt + history + tools)
    return buildLegacyContext(ctx, messages);
  }

  const taskFrame = buildTaskFrame(ctx, messages);
  const budget = computeBudget(ctx.modelId);
  const window = await compile(taskFrame, budget);

  return windowToMessages(window, messages);
}
```

This replaces the current code path that calls `readWorkspaceContext()` (which returns `[]`) and the ad-hoc system prompt + history assembly.

**Tests**:
- Integration test: `compile()` produces valid messages for the LLM
- Feature flag OFF: falls back to legacy context assembly
- Feature flag ON: agent uses compiled context
- Regression: existing agent behavior unchanged when flag is OFF
- Performance: `compile()` total < 50ms on test corpus (p99)

**Estimated effort**: 5–6 days

---

## Deliverables Checklist

- [ ] Four retrieval engines: vector, lexical, graph, temporal
- [ ] Reciprocal Rank Fusion combiner
- [ ] Knapsack packer with budget enforcement
- [ ] Token counting (tiktoken + Anthropic)
- [ ] Cache-aware layout with stable prefix
- [ ] Differential context computation
- [ ] `compile(taskFrame, budget) → ContextWindow` function
- [ ] Agent runtime integration (feature-flagged)
- [ ] `readWorkspaceContext` replaced (or bypassed) by compiler
- [ ] Performance benchmarks in CI

---

## Success Criteria

| Metric | Target |
|---|---|
| `compile()` latency (warm, project-scale) | p50 < 10ms, p99 < 50ms |
| Prompt cache hit rate (follow-up turns) | > 60% |
| Retrieval precision (golden test set) | > 70% |
| Budget compliance | 100% (never exceeds budget) |
| Agent regression | Zero failures on existing test suite with flag ON |
| Cache-stable prefix | Byte-identical across 10+ consecutive turns |

---

## Dependencies on Other Phases

| Depends On | Details |
|---|---|
| Phase A | Episodic store must be running; write API must be emitting records |
| Phase A | Record format must be stable (types imported from engram) |

| Depended On By | Details |
|---|---|
| Phase C | Cortex daemon calls `compile()` for every CLI turn |
| Phase D | Consolidation improves retrieval quality over time |
| Phase E | Multi-agent blackboard provides shared retrieval scope |

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Retrieval too slow (> 50ms p99) | Medium | Pre-warm indexes; limit Neo4j to 2-hop; cache hot records |
| Knapsack over-compresses useful content | Medium | Tune compression threshold; monitor `recall()` usage |
| Cache alignment breaks with certain providers | Low | Per-provider layout profiles; test against OpenAI + Anthropic |
| Token counting mismatch (estimated ≠ actual) | Medium | Validate against provider token counts; add 5% safety margin |
| Fusion weights need per-project tuning | High | Start with uniform weights; Phase D adds reinforcement tuning |

---

## Files Created / Modified

### Created
| File | Purpose |
|---|---|
| `packages/engram/src/retrieval/types.ts` | Retrieval type definitions |
| `packages/engram/src/retrieval/vector.ts` | Vector ANN retrieval |
| `packages/engram/src/retrieval/lexical.ts` | BM25 lexical retrieval |
| `packages/engram/src/retrieval/graph.ts` | Graph neighborhood retrieval |
| `packages/engram/src/retrieval/temporal.ts` | Recency-weighted retrieval |
| `packages/engram/src/retrieval/fusion.ts` | RRF fusion combiner |
| `packages/engram/src/compiler/compile.ts` | Top-level compile orchestrator |
| `packages/engram/src/compiler/packer.ts` | Knapsack budget packer |
| `packages/engram/src/compiler/tokenizer.ts` | Token counting |
| `packages/engram/src/compiler/compress.ts` | Compression strategies |
| `packages/engram/src/compiler/layout.ts` | Cache-aware layout |
| `packages/engram/src/compiler/diff.ts` | Differential context |
| `packages/engram/src/compiler/sections.ts` | Section types |

### Modified
| File | Change |
|---|---|
| `packages/agent/src/runtime/context-compiler.ts` | New: compile integration |
| `packages/agent/src/runtime/task-frame.ts` | New: task frame builder |
| `packages/agent/src/runtime/knowledge-graph.ts` | Bypass when compiler enabled |
| `packages/engram/src/index.ts` | Export compile() and retrieval APIs |
