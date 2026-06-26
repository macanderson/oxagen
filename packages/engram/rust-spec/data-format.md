# Data Format Spec — FlatBuffer Record Layout

> Binary record format for zero-copy FFI between TypeScript and Rust.

## Record Wire Format

All data crosses the NAPI boundary as FlatBuffer-encoded `Buffer` objects.
The TypeScript side encodes/decodes; the Rust side operates directly on the
flat memory without deserialization.

## FlatBuffer Schema

```flatbuffers
namespace engram;

enum RecordKind : byte {
  Episodic = 0,
  Semantic = 1,
  Procedural = 2,
  Entity = 3,
  Edge = 4,
}

table Namespace {
  org: string (required);
  workspace: string (required);
  session: string;
  agent: string;
}

table Provenance {
  author: string (required);
  derived_from: [string];
  tool: string;
  model: string;
  timestamp: uint64;
}

table MemoryRecord {
  // Fixed header (fast access, no indirection)
  id: string (required);       // 64-char hex (blake3)
  kind: RecordKind;
  salience: float32;
  confidence: float32;
  created_at: uint64;
  ttl: uint64;

  // Variable-length fields
  namespace: Namespace (required);
  body: [ubyte] (required);    // JSON-encoded body (opaque to Rust hot path)
  provenance: Provenance (required);
  causality: [string];

  // Embedding (fixed-size, SIMD-aligned)
  embedding: [byte];           // Int8 quantized, 1536 dimensions
}

table RecordBatch {
  records: [MemoryRecord];
}

// Retrieval result
table RetrievalCandidate {
  record_id: string;
  score: float32;
  source: string;              // "vector" | "lexical" | "graph" | "temporal"
  token_cost: uint32;
}

table RetrievalResult {
  candidates: [RetrievalCandidate];
}

// Context window
table ContextSection {
  id: string;
  section_type: string;
  content: [ubyte];            // UTF-8 encoded
  tokens: uint32;
  stable: bool;
  position: uint16;
}

table ContextWindow {
  sections: [ContextSection];
  total_tokens: uint32;
  budget_remaining: uint32;
  cache_hit_rate: float32;
  compile_ms: uint32;
}

// Merkle tree
table MerkleNode {
  hash: string;                // 64-char hex
  level: uint16;
  children: [MerkleNode];
  record_ids: [string];        // Leaf nodes only
}
```

## Embedding Format

- **Dimensions**: 1536 (text-embedding-3-small)
- **Quantization**: Int8 (linear scaling per-vector)
- **Alignment**: 16-byte aligned for SIMD (AVX2/NEON)
- **Storage**: contiguous array, row-major
- **Distance metric**: approximate cosine via dot product on quantized vectors

## Body Encoding

The `body` field is JSON-encoded bytes, opaque to the Rust hot path.
Rust does NOT parse the body during compile() — it only reads the fixed
header fields (kind, salience, confidence, createdAt) for scoring/packing.
Body parsing happens only for lexical indexing (BM25 tokenization).

## Size Estimates

| Field        | Bytes (typical) |
|---|---|
| Fixed header | 89 (id=64, kind=1, floats=8, timestamps=16) |
| Namespace    | ~60 (org+ws+session UUIDs) |
| Embedding    | 1,536 (int8 quantized) |
| Body         | 200–2000 (JSON) |
| Provenance   | ~100 |
| **Total**    | **~2–4 KB per record** |

With 100K records: ~300MB uncompressed, ~50MB with mmap + quantized embeddings.
