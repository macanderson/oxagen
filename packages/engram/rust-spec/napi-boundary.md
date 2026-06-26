# NAPI Boundary Design

> How TypeScript and Rust communicate across the FFI boundary.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Node.js Process                            │
│                                                              │
│  ┌──────────────────────┐    ┌───────────────────────────┐  │
│  │  @oxagen/engram (TS)  │    │  @oxagen/engram-native    │  │
│  │                       │    │  (Rust via NAPI-RS)       │  │
│  │  - Public API types   │    │                           │  │
│  │  - Telemetry/events   │◄──►│  - compile() hot path    │  │
│  │  - Inngest integration│    │  - Retrieval engines     │  │
│  │  - Store adapters     │    │  - CRDT merge            │  │
│  │  - Feature detection  │    │  - Merkle sync           │  │
│  │                       │    │  - Vector index          │  │
│  └──────────────────────┘    └───────────────────────────┘  │
│                                        │                     │
│                                        │ mmap               │
│                                        ▼                     │
│                              ┌───────────────────┐           │
│                              │  engram.db (file)  │           │
│                              │  - Records WAL     │           │
│                              │  - Vector index    │           │
│                              │  - Lexical index   │           │
│                              │  - Merkle cache    │           │
│                              └───────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

## NAPI-RS Setup

```toml
# Cargo.toml for @oxagen/engram-native
[package]
name = "engram-native"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "2", features = ["napi8"] }
napi-derive = "2"
blake3 = "1"
flatbuffers = "24"
usearch = "2"      # HNSW vector index
tantivy = "0.22"   # Full-text search (lexical index)
```

## Data Flow

### TypeScript → Rust (encode)

```typescript
// packages/engram/src/native/encode.ts

import { Builder } from "flatbuffers";
import type { TaskFrame } from "../retrieval/types";

export function encodeTaskFrame(frame: TaskFrame): Buffer {
  const builder = new Builder(1024);
  // ... build FlatBuffer
  return Buffer.from(builder.asUint8Array());
}
```

### Rust → TypeScript (decode)

```typescript
// packages/engram/src/native/decode.ts

import { ByteBuffer } from "flatbuffers";
import type { ContextWindow } from "../compiler/layout";

export function decodeContextWindow(buffer: Buffer): ContextWindow {
  const bb = new ByteBuffer(new Uint8Array(buffer));
  // ... read FlatBuffer fields
  return { sections, tokenUsage, cachePrefix, metadata };
}
```

## Rules for the Boundary

1. **No Rust async** — all NAPI functions are sync. Node.js libuv handles concurrency.
2. **No shared mutable state** — Rust owns its data; TS never holds a reference into Rust memory.
3. **Buffer lifetime** — buffers passed to Rust are valid only for the duration of the call. Rust must not store them.
4. **Error propagation** — Rust panics become JS exceptions via NAPI-RS. Use `Result<T, napi::Error>` for expected failures.
5. **Thread safety** — `EngramCore` is `Send + !Sync`. NAPI-RS guarantees single-threaded access from JS. Background tasks (index rebuild) use a dedicated thread pool internal to Rust.

## What Stays in TypeScript

Even with Rust core available, these remain in TypeScript:

| Concern | Why |
|---|---|
| Telemetry (ClickHouse writes) | Network I/O, async, @oxagen/telemetry integration |
| Inngest event emission | Network I/O, async, event client integration |
| Neo4j graph sync | Network I/O, async, @oxagen/ontology scoped session |
| Store adapters (ClickHouse) | Network I/O, cloud-only, existing driver |
| Access control enforcement | Simple logic, not a performance bottleneck |
| Session event log | Append-only, not compute-bound |
| UI rendering (Ink TUI) | React, not applicable to Rust |

## What Moves to Rust

Performance-critical compute that benefits from:
- No GC pauses
- SIMD vector operations
- Memory-mapped I/O
- Zero-copy data access

| Function | Reason |
|---|---|
| `compile()` orchestrator | Hot path, called every turn |
| Vector ANN query | SIMD dot product, HNSW traversal |
| BM25 lexical query | Posting list intersection |
| Token counting | Tight loop over characters |
| Knapsack packing | Sorting + greedy iteration |
| Merkle tree build/diff | Hash computation at scale |
| CRDT merge | Set operations on large collections |
| Content addressing (blake3) | Already native but called frequently |

## Versioning

- Rust spec version: `0.1.0` (this document)
- Compatible with `@oxagen/engram` TypeScript API version: `0.0.1`
- Breaking changes to the NAPI interface require a major version bump
- The FlatBuffer schema is append-only (new fields only, never remove)
