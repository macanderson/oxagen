# Phase F: Performance, Sync, and the Rust Path

> CRDT memory records for offline-first operation, Merkle-diff sync protocol,
> quantized vectors for edge deployment, Rust interface spec, and the eval harness
> as a regression gate.

---

## Overview

Phase F is the performance and durability layer. It makes Engram work offline (CRDT conflict-free writes), sync efficiently (Merkle diff — bytes proportional to changes, not corpus), run on constrained hardware (quantized vectors, ring buffers), and establishes the Rust rewrite boundary (interface spec only, no implementation). The eval harness ships here as a permanent regression gate.

After this phase, two agents working offline can merge memory without conflicts, sync transfers only what changed, the engine runs within a fixed memory budget on edge devices, and every PR is evaluated against golden traces for context quality.

---

## Prerequisites

- **Phase D complete**: Consolidation pipeline running, salience model calibrated
- **Phase E complete**: Multi-agent blackboard operational, namespace enforcement proven
- All Engram APIs stable (no breaking changes expected)
- Sufficient agent session data for golden trace construction (eval harness)
- Understanding of target edge environments (memory budget, connectivity patterns)

---

## Parallel Tracks

### Track 1: CRDT Implementation (Agent 1)

**Goal**: Make memory records conflict-free under concurrent writes from multiple agents or offline nodes.

**Deliverables**:

- `packages/engram/src/sync/crdt.ts` — CRDT primitives for memory records
- `packages/engram/src/sync/or-set.ts` — OR-Set for semantic facts
- `packages/engram/src/sync/pn-counter.ts` — PN-Counter for salience scores
- `packages/engram/src/sync/merge.ts` — Merge function for concurrent states

**CRDT strategy per memory layer**:

| Layer             | CRDT Type                            | Rationale                                    |
| ----------------- | ------------------------------------ | -------------------------------------------- |
| Episodic          | Append-only set (G-Set)              | Events are immutable; merge = union          |
| Semantic          | OR-Set (add/remove with causal tags) | Facts can be retracted; both sides preserved |
| Procedural        | OR-Set                               | Rules can be added/removed                   |
| Entity/Edge       | 2P-Set or OR-Set                     | Nodes/edges added and removed                |
| Salience counters | PN-Counter                           | Increment/decrement from multiple sources    |

**Implementation**:

```typescript
// packages/engram/src/sync/crdt.ts

export interface CRDTState<T> {
  clock: VectorClock;
  entries: Map<string, CRDTEntry<T>>;
}

export interface CRDTEntry<T> {
  value: T;
  addClock: VectorClock;
  removeClock?: VectorClock; // If removed (OR-Set)
}

export interface VectorClock {
  [nodeId: string]: number;
}
```

```typescript
// packages/engram/src/sync/or-set.ts

export class ORSet<T> {
  private entries: Map<string, { value: T; tags: Set<string> }> = new Map();
  private tombstones: Set<string> = new Set();

  /**
   * Add an element with a unique tag (nodeId + lamport).
   */
  add(value: T, tag: string): void {
    const id = this.computeId(value);
    const entry = this.entries.get(id) ?? { value, tags: new Set() };
    entry.tags.add(tag);
    this.entries.set(id, entry);
  }

  /**
   * Remove: tombstone all current tags for the element.
   * Only removes what we've seen — concurrent adds survive.
   */
  remove(value: T): void {
    const id = this.computeId(value);
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const tag of entry.tags) {
      this.tombstones.add(tag);
    }
  }

  /**
   * Merge two OR-Sets: union of entries, union of tombstones.
   * An element is present if it has at least one non-tombstoned tag.
   */
  merge(other: ORSet<T>): ORSet<T> {
    const result = new ORSet<T>();
    // Union entries and tombstones from both sides
    for (const [id, entry] of this.entries) {
      for (const tag of entry.tags) result.add(entry.value, tag);
    }
    for (const [id, entry] of other.entries) {
      for (const tag of entry.tags) result.add(entry.value, tag);
    }
    for (const t of this.tombstones) result.tombstones.add(t);
    for (const t of other.tombstones) result.tombstones.add(t);
    return result;
  }

  private computeId(value: T): string {
    return JSON.stringify(value); // Content-addressed via blake3 in real impl
  }
}
```

**Merge semantics for memory records**:

- Episodic: set-union of content-addressed events (trivially commutative)
- Semantic contradictions: both retained with provenance — resolver adjudicates later
- Salience: PN-counter merge (sum of increments − sum of decrements per node)
- Causality DAG: union of edges (DAG is append-only)

**Tests**:

- OR-Set: concurrent add/remove → element present if any non-tombstoned tag exists
- PN-Counter: concurrent increments from two nodes → correct sum after merge
- Episodic merge: union of two event logs = all events from both (no duplicates)
- Commutativity: merge(A, B) == merge(B, A) for all CRDT types
- Associativity: merge(merge(A, B), C) == merge(A, merge(B, C))

**Estimated effort**: 7–8 days

---

### Track 2: Sync Protocol (Agent 2)

**Goal**: Merkle-diff anti-entropy sync between local and cloud nodes. Transfer only changed records.

**Deliverables**:

- `packages/engram/src/sync/merkle.ts` — Merkle tree over memory records
- `packages/engram/src/sync/protocol.ts` — Sync protocol (request/response)
- `packages/engram/src/sync/transport.ts` — Transport abstraction (HTTP, WebSocket)
- `packages/engram/src/sync/priority.ts` — Prioritized sync (high-salience first)

**Merkle tree structure**:

```typescript
// packages/engram/src/sync/merkle.ts

export interface MerkleNode {
  hash: string; // blake3 of children hashes (or record ID if leaf)
  level: number; // 0 = leaf, higher = internal
  children?: MerkleNode[]; // Internal nodes only
  recordId?: string; // Leaf nodes only
}

/**
 * Build a Merkle tree over a set of memory records.
 * Records are sorted by ID (content hash) → deterministic tree.
 * Tree enables efficient diff: compare root hashes, walk divergent subtrees.
 */
export function buildMerkleTree(recordIds: string[]): MerkleNode {
  const sorted = [...recordIds].sort();
  return buildTree(sorted, 0);
}

/**
 * Diff two Merkle trees. Returns the set of record IDs present in
 * `remote` but missing in `local` (records to pull).
 */
export function diffTrees(local: MerkleNode, remote: MerkleNode): string[] {
  if (local.hash === remote.hash) return []; // Subtrees identical
  if (!local.children || !remote.children) {
    // Leaf level: return missing records
    return remote.recordId ? [remote.recordId] : [];
  }
  // Recurse into divergent children
  const missing: string[] = [];
  for (let i = 0; i < remote.children.length; i++) {
    const localChild = local.children?.[i];
    if (!localChild || localChild.hash !== remote.children[i].hash) {
      missing.push(...diffTrees(localChild ?? EMPTY_NODE, remote.children[i]));
    }
  }
  return missing;
}
```

**Sync protocol**:

```typescript
// packages/engram/src/sync/protocol.ts

export interface SyncRequest {
  type: "root_hash" | "subtree" | "pull_records" | "push_records";
  namespace: Namespace;
  payload: unknown;
}

export interface SyncSession {
  /**
   * Full sync flow:
   * 1. Exchange root hashes
   * 2. If different: walk tree, identify divergent subtrees
   * 3. Exchange missing record IDs
   * 4. Pull/push missing records (prioritized by salience)
   */
  sync(peer: SyncPeer): Promise<SyncResult>;
}

export interface SyncResult {
  recordsPulled: number;
  recordsPushed: number;
  bytesTransferred: number;
  conflictsDetected: number;
  duration: number;
}
```

**Prioritized sync**:

- High-salience records sync first (safety-critical, high-value)
- Recent records sync before old records
- Semantic facts before episodic details
- Cold episodic events backfill opportunistically

**Tests**:

- Two nodes with identical data: sync transfers 0 bytes
- One node with 10 new records: sync transfers exactly those 10
- Prioritized: high-salience records arrive before low-salience
- Large corpus (10K records): diff completes in < 100ms
- Network interruption mid-sync: resumable (record-level granularity)

**Estimated effort**: 8–10 days

---

### Track 3: Eval Harness (Agent 3)

**Goal**: Build a measurement system that runs as a CI regression gate, ensuring context quality never degrades.

**Deliverables**:

- `packages/engram/src/eval/harness.ts` — Eval runner
- `packages/engram/src/eval/metrics.ts` — Metric definitions
- `packages/engram/src/eval/golden-traces.ts` — Golden trace management
- `packages/engram/src/eval/report.ts` — Report generation
- `tools/scripts/run-eval.ts` — CI-compatible eval runner

**Metrics**:

```typescript
// packages/engram/src/eval/metrics.ts

export interface EvalMetrics {
  contextPrecision: number; // Of what was packed, how much did the model use?
  contextRecall: number; // Of what the model needed, how much was present?
  tokensToSuccess: number; // Total tokens consumed to complete the task
  retrievalHitRate: number; // % of retrieval queries that returned useful results
  rerankLift: number; // Improvement from reranking vs raw fusion
  cacheHitRate: number; // Prompt cache hit rate
  turnLatency: {
    p50: number;
    p95: number;
    p99: number;
  };
  costPerTask: number; // USD cost for task completion
  forgettingSafety: number; // % of recall(handle) that successfully returns original
}
```

**Golden traces**:

```typescript
// packages/engram/src/eval/golden-traces.ts

export interface GoldenTrace {
  id: string;
  name: string;
  description: string;
  // Input: the sequence of turns that constitute the task
  turns: GoldenTurn[];
  // Expected: what a good context window should contain
  expectedRecords: string[]; // Record IDs that should be retrieved
  // Outcome: what success looks like
  successCriteria: string;
  // Baseline: metrics from the current best run
  baseline: EvalMetrics;
}

export interface GoldenTurn {
  taskFrame: TaskFrame;
  budget: TokenBudget;
  expectedInContext: string[]; // Records that must be in the window
  expectedNotInContext: string[]; // Records that should NOT be (noise)
  toolCalls: { tool: string; input: unknown; expectedResult: unknown }[];
}
```

**Eval runner**:

- Loads golden traces from `packages/engram/eval/traces/`
- For each trace: replay turns, call `compile()`, measure metrics
- Compare against baseline — fail if any metric regresses beyond threshold
- Generate report with per-trace results and aggregate scores

**CI integration**:

- Add to `pnpm gate` as optional (doesn't block until golden traces exist)
- Once ≥ 5 golden traces are defined, make it mandatory
- Threshold: no metric may regress more than 5% from baseline
- Baseline updates manually after confirmed improvements

**Tests**:

- Eval harness runs on a minimal golden trace
- Metrics are computed correctly for known inputs
- Regression detection: intentionally degraded compile → eval fails
- Report is human-readable and shows per-trace breakdown

**Estimated effort**: 6–7 days

---

### Track 4: Rust Interface Spec (Agent 4)

**Goal**: Design the NAPI boundary and data format for a future Rust core. No implementation — spec only.

**Deliverables**:

- `packages/engram/rust-spec/interface.md` — Public API that Rust must implement
- `packages/engram/rust-spec/data-format.md` — Binary record format for FFI
- `packages/engram/rust-spec/performance.md` — Performance targets per function
- `packages/engram/rust-spec/napi-boundary.md` — NAPI bridge design

**Interface spec**:

```typescript
// What the Rust core must expose via NAPI:

interface EngramRustCore {
  // Hot path: must be < 5ms p50
  compile(taskFramePtr: Buffer, budgetPtr: Buffer): Buffer; // Returns ContextWindow as flatbuffer

  // Retrieval: must be < 2ms per engine
  vectorQuery(embeddingPtr: Buffer, limit: number): Buffer;
  lexicalQuery(queryPtr: Buffer, limit: number): Buffer;
  graphNeighbors(nodeIdPtr: Buffer, hops: number): Buffer;

  // Write path: must be < 100µs
  appendEpisodic(recordPtr: Buffer): Buffer; // Returns record ID

  // Index maintenance: async, off hot path
  rebuildVectorIndex(): void;
  rebuildLexicalIndex(): void;

  // Sync: must handle 10K records in < 1s
  merkleRoot(namespacePtr: Buffer): Buffer;
  merkleDiff(localRootPtr: Buffer, remoteRootPtr: Buffer): Buffer;

  // Memory management
  memoryUsage(): { heap: number; mmap: number; indexes: number };
  configureMemoryLimit(bytes: number): void;
}
```

**Data format**:

- FlatBuffers for zero-copy FFI (TypeScript ↔ Rust without serialization)
- Record format: fixed header (kind, namespace hash, salience, confidence, timestamps) + variable body
- Embedding format: int8 quantized, fixed dimension, aligned for SIMD
- Merkle nodes: 32-byte blake3 hashes, B-tree layout for cache locality

**Performance targets for Rust core**:

| Function                  | TypeScript (current) | Rust Target        | Speedup |
| ------------------------- | -------------------- | ------------------ | ------- |
| `compile()` p50           | < 10ms               | < 2ms              | 5x      |
| `compile()` p99           | < 50ms               | < 10ms             | 5x      |
| Vector ANN query          | < 5ms                | < 0.5ms            | 10x     |
| Episodic append           | < 100µs              | < 10µs             | 10x     |
| Merkle diff (10K records) | < 500ms              | < 50ms             | 10x     |
| Memory footprint          | ~200MB               | < 50MB (quantized) | 4x      |

**NAPI boundary design**:

- TypeScript remains the public API — user-facing types don't change
- Rust core is loaded as a native addon (`@oxagen/engram-native`)
- Feature detection: if native available, use it; otherwise fall back to TS impl
- Shared nothing: Rust manages its own memory; TS sends buffers in, gets buffers out
- No Rust async runtime (tokio) — Rust functions are sync; async handled by Node.js

**Deliverable notes**:

- This is a SPEC ONLY — no Rust code is written in Phase F
- The spec enables parallel Rust development without blocking TypeScript work
- TypeScript implementation remains the production path until Rust is ready
- Rust rewrite is a separate initiative that uses this spec as its contract

**Estimated effort**: 4–5 days

---

## Deliverables Checklist

- [ ] CRDT primitives: OR-Set, PN-Counter, G-Set
- [ ] CRDT merge for all memory layers (commutative, associative)
- [ ] Merkle tree construction over memory records
- [ ] Merkle-diff sync protocol (bytes ∝ changes)
- [ ] Prioritized sync (high-salience first)
- [ ] Sync transport abstraction (HTTP + WebSocket)
- [ ] Eval harness with metric computation
- [ ] Golden trace format and management
- [ ] CI-compatible eval runner
- [ ] Regression detection (fail on quality degradation)
- [ ] Rust interface spec (API, data format, performance targets)
- [ ] NAPI boundary design document
- [ ] Ring buffer for bounded edge memory (configurable cap)
- [ ] Quantized vectors (int8) for reduced memory footprint

---

## Success Criteria

| Metric                  | Target                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| CRDT commutativity      | 100% (property test: all orderings produce same result)             |
| Merkle sync efficiency  | Bytes transferred ∝ records changed (not corpus size)               |
| Sync resumability       | Interrupted sync resumes without re-transferring completed records  |
| Eval harness coverage   | ≥ 5 golden traces with baseline metrics                             |
| Regression detection    | Catches 5% degradation in any metric                                |
| Rust spec completeness  | All public API functions specified with types + performance targets |
| Ring buffer enforcement | Memory never exceeds configured cap (property test)                 |

---

## Dependencies on Other Phases

| Depends On | Details                                                 |
| ---------- | ------------------------------------------------------- |
| Phase D    | Salience model needed for prioritized sync              |
| Phase E    | Multi-agent blackboard needs CRDT for concurrent writes |
| Phase A–E  | All APIs must be stable for Rust spec                   |

| Depended On By         | Details                                                   |
| ---------------------- | --------------------------------------------------------- |
| Future Rust initiative | Uses the interface spec as its implementation contract    |
| Edge/robot deployment  | CRDT + sync + ring buffer enable constrained environments |

---

## Risks & Mitigations

| Risk                                             | Likelihood | Mitigation                                                  |
| ------------------------------------------------ | ---------- | ----------------------------------------------------------- |
| CRDT overhead too high for hot path              | Medium     | CRDTs on write path only; read path uses materialized views |
| Merkle tree too deep for large corpora           | Low        | B-tree layout (high fanout); cache intermediate hashes      |
| Golden traces become stale                       | Medium     | Auto-update baselines quarterly; human review required      |
| Rust spec becomes outdated before implementation | High       | Version the spec; treat as living document with change log  |
| Quantized vectors lose too much precision        | Low        | Benchmark recall@k before and after quantization            |

---

## Files Created / Modified

### Created

| File                                         | Purpose                 |
| -------------------------------------------- | ----------------------- |
| `packages/engram/src/sync/crdt.ts`           | CRDT primitives         |
| `packages/engram/src/sync/or-set.ts`         | OR-Set implementation   |
| `packages/engram/src/sync/pn-counter.ts`     | PN-Counter              |
| `packages/engram/src/sync/merge.ts`          | Record merge function   |
| `packages/engram/src/sync/merkle.ts`         | Merkle tree             |
| `packages/engram/src/sync/protocol.ts`       | Sync protocol           |
| `packages/engram/src/sync/transport.ts`      | Transport abstraction   |
| `packages/engram/src/sync/priority.ts`       | Prioritized sync        |
| `packages/engram/src/eval/harness.ts`        | Eval runner             |
| `packages/engram/src/eval/metrics.ts`        | Metric definitions      |
| `packages/engram/src/eval/golden-traces.ts`  | Golden trace management |
| `packages/engram/src/eval/report.ts`         | Report generation       |
| `packages/engram/eval/traces/`               | Golden trace directory  |
| `packages/engram/rust-spec/interface.md`     | Rust API spec           |
| `packages/engram/rust-spec/data-format.md`   | Binary format spec      |
| `packages/engram/rust-spec/performance.md`   | Performance targets     |
| `packages/engram/rust-spec/napi-boundary.md` | NAPI design             |
| `tools/scripts/run-eval.ts`                  | CI eval runner          |

### Modified

| File                                    | Change                                      |
| --------------------------------------- | ------------------------------------------- |
| `packages/engram/src/record.ts`         | Add CRDT metadata to records                |
| `packages/engram/src/store/episodic.ts` | Add ring buffer mode                        |
| `packages/engram/src/index.ts`          | Export sync + eval modules                  |
| `turbo.json`                            | Add eval task to pipeline                   |
| `.github/workflows/pipeline.yml`        | Add eval step (optional until traces exist) |
