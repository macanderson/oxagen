# Performance Targets — Rust Core

> Hard targets for each function. The Rust implementation must meet these
> before it replaces the TypeScript path in production.

## Latency Targets

| Function | TypeScript (current) | Rust Target | Speedup | Measurement |
|---|---|---|---|---|
| `compile()` p50 | < 10ms | < 2ms | 5x | Wall clock, warm cache |
| `compile()` p99 | < 50ms | < 10ms | 5x | Wall clock, cold start |
| `vector_query()` | < 5ms | < 0.5ms | 10x | 1536-dim, 100K corpus |
| `lexical_query()` | < 5ms | < 1ms | 5x | BM25 over 100K records |
| `graph_neighbors()` | < 3ms | < 0.5ms | 6x | 2-hop, in-memory graph |
| `temporal_query()` | < 2ms | < 0.2ms | 10x | Sorted scan + decay |
| `append_record()` | < 100µs | < 10µs | 10x | Single record, WAL write |
| `append_batch(100)` | < 5ms | < 500µs | 10x | 100 records, batch WAL |
| `merkle_root()` | < 50ms | < 5ms | 10x | 100K records |
| `merkle_diff()` | < 500ms | < 50ms | 10x | Two 100K-record trees |
| `crdt_merge()` | < 100ms | < 10ms | 10x | 1K records, 2 replicas |

## Memory Targets

| Metric | TypeScript | Rust Target | Notes |
|---|---|---|---|
| Base footprint | ~50MB | < 10MB | No V8 heap, no GC |
| 10K records | ~100MB | < 25MB | Quantized embeddings |
| 100K records | ~500MB | < 80MB | mmap'd, lazy load |
| Vector index (100K) | ~60MB | < 20MB | int8 + HNSW compressed |
| Lexical index (100K) | ~40MB | < 15MB | FST + postings |
| Peak during compile | +50MB | +5MB | Stack allocation, no heap |

## Throughput Targets

| Operation | Target | Sustained | Notes |
|---|---|---|---|
| Record writes | 100K/s | 50K/s sustained | WAL + batch commit |
| Vector queries | 10K/s | Single-threaded | SIMD dot product |
| Compile calls | 500/s | Per-core | No blocking I/O in hot path |
| Sync (record/s) | 50K/s | Network-bound | FlatBuffer transfer |

## Benchmarking Requirements

1. **Benchmark suite ships with the Rust crate** — `cargo bench`
2. **Golden dataset**: 100K records across 5 workspaces, realistic distribution
3. **CI gate**: benchmarks run on every PR, regress by > 10% = block
4. **Environment**: Apple M-series (dev) + x86_64 Linux (CI/prod)
5. **Comparison**: each bench reports TypeScript baseline vs Rust for the same input

## Critical Path Optimization Notes

### compile() (target: < 2ms p50)

The compile hot path must avoid:
- Heap allocation (use arena allocator or stack)
- String serialization (operate on FlatBuffer offsets)
- Hash recomputation (cache Merkle hashes)
- Lock contention (read-only snapshot for retrieval)

Suggested Rust architecture:
```
TaskFrame (FlatBuffer) → Retrieval (SIMD parallel) → Fusion (sort, no alloc)
→ Pack (greedy, bounded loop) → Layout (memcpy sections) → Output (FlatBuffer)
```

### vector_query() (target: < 0.5ms)

- Use `usearch` or custom HNSW with int8 SIMD distance
- Pre-quantize all vectors at write time
- Graph in mmap'd file, no deserialization on query
- Candidate pruning: early exit when score drops below threshold

### append_record() (target: < 10µs)

- WAL append (sequential write, no fsync per record)
- Group commit: batch fsync every 10ms or 100 records
- blake3 hash is ~200ns for a typical record (already fast)
- Index update deferred to background thread
