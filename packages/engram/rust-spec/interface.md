# Rust Interface Spec — `@oxagen/engram-native`

> This document defines the public API that a future Rust implementation must
> expose via NAPI. The TypeScript implementation remains production until Rust
> is ready. This spec is the contract — no breaking changes without a major version.

## Design Principles

1. **TypeScript stays the public API** — user-facing types never change
2. **Rust is a drop-in accelerator** — feature detection at runtime
3. **Shared nothing** — Rust manages its own memory; TS sends buffers in, gets buffers out
4. **No Rust async runtime** — functions are sync from Node's perspective; async handled by libuv
5. **FlatBuffers for FFI** — zero-copy data exchange without serialization overhead

## Public API

```rust
// The NAPI boundary — what Node.js sees

#[napi]
pub struct EngramCore {
    store: EpisodicStore,
    vector_index: VectorIndex,
    lexical_index: LexicalIndex,
    graph_cache: GraphCache,
}

#[napi]
impl EngramCore {
    // ─── Hot Path (< 5ms p50) ───────────────────────────────────────────

    /// Compile a context window from a task frame + budget.
    /// Input/output are FlatBuffer-encoded.
    #[napi]
    pub fn compile(&self, task_frame: Buffer, budget: Buffer) -> Buffer;

    // ─── Retrieval (< 2ms per engine) ───────────────────────────────────

    /// ANN vector similarity search.
    #[napi]
    pub fn vector_query(&self, embedding: Buffer, limit: u32) -> Buffer;

    /// BM25 full-text search.
    #[napi]
    pub fn lexical_query(&self, query: Buffer, limit: u32) -> Buffer;

    /// k-hop graph neighborhood traversal.
    #[napi]
    pub fn graph_neighbors(&self, node_id: Buffer, hops: u32) -> Buffer;

    /// Recency-weighted temporal retrieval.
    #[napi]
    pub fn temporal_query(&self, namespace: Buffer, limit: u32) -> Buffer;

    // ─── Write Path (< 100µs → target < 10µs) ──────────────────────────

    /// Append a record to the episodic store. Returns the record ID.
    #[napi]
    pub fn append_record(&mut self, record: Buffer) -> Buffer;

    /// Batch append (transactional).
    #[napi]
    pub fn append_batch(&mut self, records: Buffer) -> Buffer;

    // ─── Sync (10K records in < 1s) ─────────────────────────────────────

    /// Get the Merkle root hash for a namespace.
    #[napi]
    pub fn merkle_root(&self, namespace: Buffer) -> Buffer;

    /// Diff two Merkle trees, returning missing record IDs.
    #[napi]
    pub fn merkle_diff(&self, local_root: Buffer, remote_root: Buffer) -> Buffer;

    /// Merge remote records using CRDT semantics.
    #[napi]
    pub fn crdt_merge(&mut self, local: Buffer, remote: Buffer) -> Buffer;

    // ─── Index Maintenance (async, off hot path) ────────────────────────

    /// Rebuild the vector index from current records.
    #[napi]
    pub fn rebuild_vector_index(&mut self);

    /// Rebuild the lexical index.
    #[napi]
    pub fn rebuild_lexical_index(&mut self);

    // ─── Memory Management ──────────────────────────────────────────────

    /// Current memory usage breakdown.
    #[napi]
    pub fn memory_usage(&self) -> MemoryUsage;

    /// Configure maximum memory budget (ring buffer eviction beyond this).
    #[napi]
    pub fn configure_memory_limit(&mut self, bytes: u64);
}

#[napi(object)]
pub struct MemoryUsage {
    pub heap_bytes: u64,
    pub mmap_bytes: u64,
    pub vector_index_bytes: u64,
    pub lexical_index_bytes: u64,
    pub record_store_bytes: u64,
}
```

## Feature Detection

```typescript
// packages/engram/src/native/loader.ts

let _native: EngramCore | null = null;

export function getNativeCore(): EngramCore | null {
  if (_native !== undefined) return _native;
  try {
    const { EngramCore } = require("@oxagen/engram-native");
    _native = new EngramCore();
    return _native;
  } catch {
    _native = null; // Native not available — use TS implementation
    return null;
  }
}

export function isNativeAvailable(): boolean {
  return getNativeCore() !== null;
}
```

## Migration Path

1. Ship `@oxagen/engram-native` as an optional dependency
2. `packages/engram` auto-detects and delegates to native when available
3. All existing tests pass against both implementations (same golden traces)
4. Gradually move hot paths to native: compile → retrieval → write → sync
5. TypeScript remains for: telemetry, event emission, Inngest integration, UI
