# Phase A: Memory Substrate + Content Addressing

> Foundation layer. Ship `packages/engram` with typed memory records, content-addressed
> identity, and an episodic event store. Everything else builds on this.

---

## Overview

Phase A establishes the memory substrate — the append-only, content-addressed, tiered storage that replaces raw text in Neo4j AgentMemory nodes. After this phase, agents emit structured episodic events that are deduplicated by content, scoped by namespace, and queryable by the context compiler (Phase B).

The key insight: write cheap and fast (episodic append), derive everything else asynchronously. This phase builds only the write path and the record format. The read path (`compile()`) is Phase B.

---

## Prerequisites

- Monorepo `pnpm gate` passes (baseline stable)
- Decision: DuckDB for local episodic (confirmed)
- Decision: blake3 for content addressing (WASM build available: `@aspect-build/blake3` or `blake3-wasm`)
- Decision: TypeScript-first (Rust interface spec deferred to Phase F)
- Neo4j continues running for entity/relational graph (no changes to ontology)

---

## Parallel Tracks

### Track 1: Record Format + Types (Agent 1)

**Goal**: Define the `MemoryRecord` type, content addressing, and namespace schema.

**Deliverables**:
- `packages/engram/src/types.ts` — Core type definitions
- `packages/engram/src/record.ts` — `MemoryRecord` creation + content addressing
- `packages/engram/src/namespace.ts` — Hierarchical namespace type + validation
- `packages/engram/package.json`, `tsconfig.json`, `vitest.config.ts` — Package scaffolding

**Implementation**:

```typescript
// packages/engram/src/types.ts

export type RecordKind = "episodic" | "semantic" | "procedural" | "entity" | "edge";

export interface Namespace {
  org: string;
  workspace: string;
  session?: string;
  agent?: string;
}

export interface Provenance {
  author: string;           // agent ID or user ID
  derivedFrom: string[];    // parent record IDs (content hashes)
  tool?: string;            // tool that produced this
  model?: string;           // LLM model used
  timestamp: number;        // Unix ms
}

export interface MemoryRecord {
  id: string;               // blake3(body + kind + namespace) — content address
  kind: RecordKind;
  namespace: Namespace;
  body: unknown;            // Typed per kind (see RecordBody union)
  embedding?: Int8Array;    // Quantized; optional at write time
  salience: number;         // 0.0–1.0, importance at write time
  confidence: number;       // 0.0–1.0, for facts that may be wrong
  provenance: Provenance;
  causality: string[];      // Parent record IDs (DAG edges)
  ttl?: number;             // Unix ms expiry (optional)
  createdAt: number;        // Unix ms
}

// Per-kind body types
export interface EpisodicBody {
  event: string;            // Event type (tool_call, observation, decision, etc.)
  payload: unknown;         // Structured event data
  outcome?: "success" | "failure" | "unknown";
}

export interface SemanticBody {
  fact: string;             // The distilled fact
  domain: string;           // Category (auth, db, api, etc.)
  supersedes?: string[];    // Record IDs this fact replaces
}

export interface ProceduralBody {
  rule: string;             // The rule/instruction
  appliesTo: string[];      // Task/context patterns where this applies
  examples?: string[];      // Example applications
  successCount: number;     // Times this rule led to success
  failureCount: number;     // Times this rule led to failure
}

export interface EntityBody {
  entityType: string;       // From ontology (file, function, service, person, etc.)
  name: string;
  properties: Record<string, unknown>;
}

export interface EdgeBody {
  sourceId: string;         // Source entity record ID
  targetId: string;         // Target entity record ID
  edgeType: string;         // From EdgeTypes in packages/ontology
  properties?: Record<string, unknown>;
}
```

**Content addressing**:

```typescript
// packages/engram/src/record.ts
import { blake3 } from "@aspect-build/blake3";

export function computeRecordId(kind: RecordKind, namespace: Namespace, body: unknown): string {
  const content = JSON.stringify({ kind, namespace, body });
  return blake3(content, { length: 32 }).toString("hex");
}

export function createRecord(params: Omit<MemoryRecord, "id" | "createdAt">): MemoryRecord {
  const id = computeRecordId(params.kind, params.namespace, params.body);
  return { ...params, id, createdAt: Date.now() };
}
```

**Tests**:
- Identical content → identical ID (dedup property)
- Different content → different ID (collision resistance)
- Namespace validation (all required fields present)
- Record creation with all body types

**Estimated effort**: 3–4 days

---

### Track 2: Episodic Store Adapters (Agent 2)

**Goal**: Implement the append-only episodic event store with DuckDB (local) and ClickHouse (cloud) adapters.

**Deliverables**:
- `packages/engram/src/store/episodic.ts` — Store interface
- `packages/engram/src/store/duckdb-adapter.ts` — DuckDB local implementation
- `packages/engram/src/store/clickhouse-adapter.ts` — ClickHouse cloud implementation
- `packages/engram/src/store/index.ts` — Factory function based on environment

**Implementation**:

```typescript
// packages/engram/src/store/episodic.ts

export interface EpisodicStore {
  append(record: MemoryRecord): Promise<void>;
  appendBatch(records: MemoryRecord[]): Promise<void>;
  query(opts: EpisodicQuery): Promise<MemoryRecord[]>;
  getById(id: string): Promise<MemoryRecord | null>;
  getByIds(ids: string[]): Promise<MemoryRecord[]>;
  recent(namespace: Namespace, limit: number, minSalience?: number): Promise<MemoryRecord[]>;
}

export interface EpisodicQuery {
  namespace: Namespace;
  after?: number;           // Unix ms — temporal filter
  before?: number;
  kinds?: RecordKind[];
  minSalience?: number;
  limit: number;
  offset?: number;
}
```

**DuckDB adapter**:
- Uses `duckdb-node` package (native binary, fast)
- Creates a Parquet-backed table per workspace
- Append-only: no UPDATE/DELETE operations
- Schema: all `MemoryRecord` fields as columns, `body` as JSON
- Index on `(namespace_org, namespace_workspace, createdAt)`

**ClickHouse adapter**:
- Uses existing ClickHouse connection from `packages/telemetry`
- New table: `engram.episodic_events` (MergeTree, partitioned by month + org)
- Same schema as DuckDB for portability
- Append-only with ClickHouse's native dedup on insert (ReplacingMergeTree by record ID)

**Tests**:
- Append + query round-trip
- Dedup: appending same record twice → only one stored
- Temporal range queries
- Namespace scoping (query never returns cross-namespace records)
- Batch append performance (< 100µs per record)

**Estimated effort**: 5–7 days

---

### Track 3: Migration Bridge (Agent 3)

**Goal**: Read existing AgentMemory nodes from Neo4j and emit them as Engram episodic records.

**Deliverables**:
- `packages/engram/src/migration/neo4j-to-engram.ts` — Migration script
- `packages/engram/src/migration/types.ts` — Mapping from `MemoryRow` to `MemoryRecord`
- `tools/scripts/migrate-agent-memory.ts` — Runnable migration command

**Implementation**:

The migration reads from Neo4j's `AgentMemory` nodes (same shape as `packages/agent/src/memory/neo4j.ts`) and converts each into an Engram `MemoryRecord`:

```typescript
// Mapping:
// MemoryRow.id        → MemoryRecord.provenance (original Neo4j ID)
// MemoryRow.nodeRef   → MemoryRecord.body.entityType reference
// MemoryRow.weight    → MemoryRecord.salience (low=0.3, high=0.6, critical=0.9)
// MemoryRow.kind      → MemoryRecord.kind (map to closest RecordKind)
// MemoryRow.lesson    → MemoryRecord.body.fact (for semantic) or body.event (for episodic)
// MemoryRow.source    → MemoryRecord.provenance.tool
// MemoryRow.score     → MemoryRecord.confidence
// MemoryRow.createdAt → MemoryRecord.createdAt
```

**Migration strategy**:
- Run once per workspace (batch, not streaming)
- Idempotent: content addressing means re-running produces the same IDs
- Does NOT delete from Neo4j (dual-read period)
- Logs mapping results for audit

**Tests**:
- Round-trip: Neo4j memory → Engram record → verify all fields map correctly
- Idempotency: running twice produces identical output
- Edge cases: missing fields, null embeddings, malformed `createdAt`

**Estimated effort**: 3–4 days

---

### Track 4: Write-Path API (Agent 4)

**Goal**: Public API surface for writing to Engram, integrated into the agent runtime behind a feature flag.

**Deliverables**:
- `packages/engram/src/index.ts` — Public API exports
- `packages/engram/src/api/remember.ts` — `engram.remember(event)` (episodic write)
- `packages/engram/src/api/assert.ts` — `engram.assert(fact, confidence, provenance)` (semantic write)
- `packages/engram/src/api/relate.ts` — `engram.relate(src, edge, dst)` (entity/edge write)
- `packages/engram/src/api/pin.ts` — `engram.pin(rule)` / `engram.unpin(id)` (procedural write)
- `packages/agent/src/runtime/engram-writer.ts` — Integration point in agent runtime

**Implementation**:

```typescript
// packages/engram/src/index.ts — Public API

export interface Engram {
  // Write operations (non-blocking, < 100µs)
  remember(event: EpisodicBody, opts: WriteOpts): Promise<string>;
  assert(fact: SemanticBody, confidence: number, provenance: Provenance): Promise<string>;
  relate(source: string, edgeType: string, target: string, props?: Record<string, unknown>): Promise<string>;
  pin(rule: ProceduralBody): Promise<string>;
  unpin(id: string): Promise<void>;
}

export interface WriteOpts {
  namespace: Namespace;
  salience?: number;        // Default: computed by heuristic
  causality?: string[];     // Parent event IDs
  provenance: Provenance;
}
```

**Agent runtime integration** (feature-flagged):

```typescript
// packages/agent/src/runtime/engram-writer.ts
import { createEngram } from "@oxagen/engram";

const ENGRAM_ENABLED = process.env.ENGRAM_WRITE_ENABLED === "true";

export async function emitAgentEvent(ctx: CapabilityContext, event: EpisodicBody): Promise<void> {
  if (!ENGRAM_ENABLED) return;
  const engram = createEngram({ store: getStoreForEnvironment() });
  await engram.remember(event, {
    namespace: { org: ctx.orgId, workspace: ctx.workspaceId },
    provenance: { author: ctx.agentId ?? "system", derivedFrom: [], timestamp: Date.now() },
  });
}
```

**Tests**:
- Each write operation produces a content-addressed record
- Writes are non-blocking (async, no await on critical path)
- Feature flag OFF → no writes, no errors
- Feature flag ON → records appear in episodic store
- Namespace is validated before write (throws `NamespaceScopeError` if missing)

**Estimated effort**: 4–5 days

---

## Deliverables Checklist

- [ ] `packages/engram/` package created and building in monorepo
- [ ] `MemoryRecord` type defined with all body variants
- [ ] Content addressing via blake3 (identical content → identical ID)
- [ ] DuckDB episodic store adapter (local/dev)
- [ ] ClickHouse episodic store adapter (cloud)
- [ ] Store interface supports append, query, getById, recent
- [ ] Migration script: Neo4j AgentMemory → Engram records
- [ ] Write API: `remember()`, `assert()`, `relate()`, `pin()`, `unpin()`
- [ ] Agent runtime integration (feature-flagged)
- [ ] `pnpm gate` passes with `packages/engram` included
- [ ] Unit tests for all tracks (> 80% coverage on new code)

---

## Success Criteria

| Metric | Target |
|---|---|
| Write latency (episodic append, local DuckDB) | < 100µs |
| Content addressing correctness | 100% (property test: identical input → identical ID) |
| Dedup effectiveness | Duplicate writes produce 0 additional records |
| Migration completeness | All existing AgentMemory nodes mapped to Engram records |
| Feature flag safety | ENGRAM_WRITE_ENABLED=false → zero side effects |
| CI integration | `packages/engram` in `pnpm gate` pipeline |

---

## Dependencies on Other Phases

| Depends On | Details |
|---|---|
| None | Phase A is the foundation — no upstream dependencies |

| Depended On By | Details |
|---|---|
| Phase B | Context compiler reads from the episodic store |
| Phase C | Cortex daemon maintains Engram as its persistent state |
| Phase D | Consolidation reads episodic events and writes semantic/procedural |
| Phase E | Blackboard extends the namespace model for multi-agent |
| Phase F | CRDT semantics applied to record format |

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| blake3 WASM too slow for high-volume writes | Low | Benchmark early; fallback to native blake3 binary |
| DuckDB WASM bundle too large for CLI | Medium | Use native `duckdb-node` binary; WASM only for browser contexts |
| Content addressing collisions | Negligible | blake3 is 256-bit; include namespace in hash input |
| Migration corrupts existing memories | Low | Migration is additive (no Neo4j deletes); validate with checksums |
| Feature flag leaks (writes when disabled) | Low | Integration test: mock store, verify zero calls when flag OFF |

---

## Package Configuration

```json
// packages/engram/package.json
{
  "name": "@oxagen/engram",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@aspect-build/blake3": "^1.x",
    "duckdb": "^1.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "vitest": "workspace:*",
    "typescript": "workspace:*"
  }
}
```

---

## Files Created / Modified

### Created
| File | Purpose |
|---|---|
| `packages/engram/package.json` | Package manifest |
| `packages/engram/tsconfig.json` | TypeScript config (extends monorepo base) |
| `packages/engram/vitest.config.ts` | Test configuration |
| `packages/engram/src/index.ts` | Public API barrel |
| `packages/engram/src/types.ts` | Core type definitions |
| `packages/engram/src/record.ts` | Record creation + content addressing |
| `packages/engram/src/namespace.ts` | Namespace validation |
| `packages/engram/src/salience.ts` | Write-time salience heuristic |
| `packages/engram/src/store/episodic.ts` | Store interface |
| `packages/engram/src/store/duckdb-adapter.ts` | DuckDB implementation |
| `packages/engram/src/store/clickhouse-adapter.ts` | ClickHouse implementation |
| `packages/engram/src/store/index.ts` | Store factory |
| `packages/engram/src/api/remember.ts` | Episodic write |
| `packages/engram/src/api/assert.ts` | Semantic write |
| `packages/engram/src/api/relate.ts` | Entity/edge write |
| `packages/engram/src/api/pin.ts` | Procedural write |
| `packages/engram/src/migration/neo4j-to-engram.ts` | Migration logic |
| `packages/engram/src/migration/types.ts` | Migration type mappings |
| `tools/scripts/migrate-agent-memory.ts` | Runnable migration script |

### Modified
| File | Change |
|---|---|
| `pnpm-workspace.yaml` | Add `packages/engram` |
| `turbo.json` | Add `@oxagen/engram` to pipeline |
| `packages/agent/src/runtime/engram-writer.ts` | New file: agent runtime integration |
| `packages/agent/package.json` | Add `@oxagen/engram` dependency |
