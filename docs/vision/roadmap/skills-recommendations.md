# Skills Recommendations — Anti-Drift Guardrails

> Skills that enforce context engine patterns, prevent architectural drift, and keep
> the platform evolving toward the vision rather than accreting ad-hoc solutions.

---

## New Skills to Create

### 1. `context-engine-patterns` (Critical)

**Purpose**: Enforce correct usage of the Engram API in all agent runtime code. Prevent anyone from building ad-hoc context assembly that bypasses the compiler.

```yaml
name: context-engine-patterns
description: Enforce Engram context compiler usage patterns
metadata:
  weight: critical
  category: architecture
```

**Rules to encode**:
- Never concatenate raw strings into agent context — use `engram.compile()`
- Never fetch context without a token budget — budget is mandatory
- Memory writes go through `engram.remember()`, not direct store access
- Tool results must be structured (typed payload), not raw text blobs
- Session state must be event-sourced — no mutable session objects
- Context layout must maintain a stable prefix for cache alignment
- Retrieval must use the fusion pipeline, not a single index

**When to inject**: Any task touching `packages/agent`, `packages/engram`, or agent-related capabilities.

### 2. `memory-record-format` (High)

**Purpose**: Enforce the MemoryRecord format contract. Prevent untyped prose from entering the memory substrate.

```yaml
name: memory-record-format
description: Enforce typed memory record format for all memory writes
metadata:
  weight: high
  category: data-integrity
```

**Rules to encode**:
- Every memory write must produce a content-addressed `MemoryRecord`
- Records must have: `kind`, `namespace`, `body` (typed), `provenance`
- Confidence scores are required for semantic assertions
- Provenance must include `author`, `derived_from`, and `tool`
- Episodic records must include `causality` parent IDs for DAG integrity
- Never store raw prose — use structured body types per record kind
- Embeddings are optional at write time (computed async) but required for retrieval

**When to inject**: Any task creating or modifying memory write paths.

### 3. `engram-store-boundaries` (High)

**Purpose**: Enforce the four-store architecture. Prevent mixing storage concerns.

```yaml
name: engram-store-boundaries
description: Enforce separation of storage concerns across Engram's four stores
metadata:
  weight: high
  category: architecture
```

**Rules to encode**:
- Episodic events → append-only columnar (DuckDB local, ClickHouse cloud)
- Semantic facts → Neo4j with confidence + provenance properties
- Entity/relational → Neo4j graph with typed edges from `packages/ontology`
- Procedural rules → filesystem `.skill.md` with retrieval index
- Blobs → Vercel Blob / object store, referenced by ID in records
- Transactional state (sessions, leases, config) → Postgres via `packages/database`
- Never put graph relationships in the columnar store
- Never put mutable state in the episodic log (it's append-only)

**When to inject**: Any task touching storage adapters or data persistence.

### 4. `cache-aware-layout` (High)

**Purpose**: Prevent context layout changes that break prompt cache stability.

```yaml
name: cache-aware-layout
description: Enforce cache-stable prompt layout rules
metadata:
  weight: high
  category: performance
```

**Rules to encode**:
- Prompt prefix order: `[system] → [procedural rules] → [stable project facts] → [code skeleton] → [volatile context] → [working memory]`
- System prompt and procedural rules NEVER change position between turns
- New volatile content appends to the tail, never inserts into the prefix
- Stable sections are byte-identical across turns (character-for-character)
- Measure prompt-cache hit rate; alert if < 60% on follow-up turns
- Differential context computes deltas against the previous turn's tail only
- Never reorder sections based on per-turn relevance scoring

**When to inject**: Any task modifying the context compiler's layout system.

### 5. `consolidation-safety` (High)

**Purpose**: Ensure the consolidation ("sleep") pipeline never loses information or silently overwrites knowledge.

```yaml
name: consolidation-safety
description: Safety invariants for the background consolidation pipeline
metadata:
  weight: high
  category: data-integrity
```

**Rules to encode**:
- Summarize-with-pointer: original is always recoverable via `engram.recall(handle)`
- Never delete episodic events — only compress/archive to cold tier
- Conflicting facts are BOTH retained with provenance; never last-writer-wins
- Confidence scores adjust, not replace — track full confidence history
- Decay is reversible: decayed records move to cold, not deleted
- Procedural promotion requires N successful uses (configurable threshold)
- Consolidation runs are idempotent — re-running produces the same result

**When to inject**: Any task touching consolidation, decay, or memory cleanup.

### 6. `namespace-enforcement` (Critical)

**Purpose**: Multi-tenancy at the memory boundary. Every read/write must be scoped.

```yaml
name: namespace-enforcement
description: Enforce hierarchical namespace scoping on all Engram operations
metadata:
  weight: critical
  category: security
```

**Rules to encode**:
- Every Engram API call must include a namespace: `org/workspace/session/agent`
- Reads are RLS-filtered at the engine boundary (not application layer)
- An agent sees: its private namespace + shared namespaces it's entitled to
- Cross-namespace reads require explicit grant (never implicit)
- Namespace maps to existing `runInTenantScope` pattern for Postgres operations
- Neo4j queries include `orgId` + `workspaceId` predicates (existing pattern)
- ClickHouse queries include tenant partition predicates
- Never expose records from one org to another, even in consolidation

**When to inject**: Any task touching Engram's read/write path or multi-agent coordination.

### 7. `structured-tool-io` (High)

**Purpose**: Prevent raw text blobs from tool results entering the context window.

```yaml
name: structured-tool-io
description: Enforce structured tool input/output for context indexing
metadata:
  weight: high
  category: context-quality
```

**Rules to encode**:
- Tool results must return a typed payload (Zod-validated), not raw text
- Large tool outputs are indexed as Engram records, not pasted into context
- The compiler decides what portion of a tool result to include (not the tool itself)
- Tool results carry a summary + retrieval handle for page-back-in
- File contents returned by tools include metadata (path, language, line range)
- Command outputs include exit code, timing, and structured error info
- Never paste more than 2000 tokens of raw tool output into context

**When to inject**: Any task modifying tool execution or result handling in the agent runtime.

---

## Existing Skills to Update

### 8. Update: Agent Runtime Skill

**Current focus**: Tool materialization, approval flow, knowledge graph injection.

**Updates needed**:
- Add: "Context assembly uses `engram.compile()`, not ad-hoc string building"
- Add: "Tool results are indexed Engram records, query via retrieval"
- Add: "Sessions are event-sourced; state changes are events, not mutations"
- Remove: References to `readWorkspaceContext` and `injectContext` (after Phase B)
- Update: Knowledge graph injection section → replaced by Engram entity retrieval

### 9. Update: Ingestion Pipeline Skill

**Current focus**: Connector normalization, dedup, embed, infer.

**Updates needed**:
- Add: "Emit Engram episodic record on every entity upsert"
- Add: "Tree-sitter output feeds the incremental code graph (file-watch mode)"
- Add: "Dedup result maps to Engram content addressing (same content = same ID)"
- Add: "Inferred semantic edges are Engram entity records with provenance"

### 10. Update: Telemetry Skill

**Current focus**: ClickHouse event emission, security audit, token usage.

**Updates needed**:
- Add: "Every telemetry event is also an Engram episodic record (content-addressed)"
- Add: "Salience heuristic runs on emission — high-salience events get priority retrieval"
- Add: "Token usage events inform the context compiler's budget allocation"

### 11. Update: Skills System Skill (Meta)

**Current focus**: File-based `.skill.md`, registry, lazy loading, tenant override.

**Updates needed**:
- Add: "Skills are procedural memory — selected by relevance, not loaded all-at-once"
- Add: "Each skill has a pre-computed embedding for vector retrieval"
- Add: "Unused skills don't burn context tokens — only relevant skills are injected"
- Add: "Consolidation can promote successful agent patterns into new skill proposals"
- Keep: Filesystem-first, YAML frontmatter, tenant override mechanics

---

## Anti-Drift Guardrails

### Architectural Invariants

These are invariants that CI/linting should enforce. Each maps to a concrete check:

| Invariant | Check | Location |
|---|---|---|
| No raw string context assembly in agent runtime | Lint rule: ban string concat in `packages/agent/src/runtime/` for context building | ESLint custom rule |
| All memory writes produce content-addressed records | Unit test: every `engram.remember()` call returns a blake3-based ID | `packages/engram/src/__tests__/` |
| `compile()` respects budget | Property test: output tokens ≤ budget for all inputs | `packages/engram/src/compiler/__tests__/` |
| Cache-stable prefix | Integration test: prefix bytes identical across consecutive `compile()` calls | `packages/engram/src/compiler/__tests__/` |
| Namespace scoping on all reads | Unit test: reads without namespace throw `NamespaceScopeError` | `packages/engram/src/__tests__/` |
| No direct Neo4j memory access from agent runtime | Lint rule: ban imports of `neo4j.ts` memory functions in new code | ESLint `no-restricted-imports` |
| Structured tool results only | Type check: tool handlers must return `StructuredToolResult`, not `string` | TypeScript strict types |

### Drift Detection Script

Add to `pnpm gate`:

```bash
# tools/scripts/check-context-patterns.mjs
# Checks:
# 1. No new raw context assembly (grep for string concat in agent runtime)
# 2. All Engram writes go through the public API (no direct store access)
# 3. No new tools returning raw text > 2000 tokens
# 4. Namespace present on all Engram calls
```

### Review Checklist (for PRs touching agent/engram)

- [ ] Does this PR bypass `engram.compile()` for context assembly?
- [ ] Does this PR write untyped data to the memory substrate?
- [ ] Does this PR break cache-stable prefix ordering?
- [ ] Does this PR introduce a direct store access (bypassing Engram API)?
- [ ] Does this PR add a tool that returns raw text > 2000 tokens?
- [ ] Does this PR respect namespace scoping?
- [ ] Does this PR have salience scoring on new memory writes?

---

## Skill Injection Strategy

### Phase A Skills Active
- `memory-record-format`
- `engram-store-boundaries`
- `namespace-enforcement`

### Phase B Skills Active (adds)
- `context-engine-patterns`
- `cache-aware-layout`
- `structured-tool-io`

### Phase D Skills Active (adds)
- `consolidation-safety`

### Retrieval-Based Injection (Phase B+)

Once skills are retrievable procedural memory, injection becomes automatic:
- Agent working on memory code → `memory-record-format` surfaces via relevance
- Agent working on layout → `cache-aware-layout` surfaces
- Agent working on security → `namespace-enforcement` surfaces
- No manual injection needed — the context compiler handles it

This is the endgame: skills protect against drift by being *automatically relevant* to the work being done, not by being statically loaded into every context window.
