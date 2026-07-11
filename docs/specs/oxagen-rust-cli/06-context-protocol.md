# Oxagen Rust CLI — The Context Plane & the Open Context Protocol (OCP)

Two deliverables share this document because one proves the other:

- **The local context plane** (`oxagen-context` + `oxagen-graph`): embeddings
  and a knowledge graph on the user's disk, in the base binary, no server —
  the product feature.
- **The Open Context Protocol** (`ocp-types` / `ocp-host` /
  `ocp-conformance`): an open, versioned, transport-level standard for
  *serving context to agents*, designed for adoption beyond this tool — the
  industry contribution. The binary is its first host; the code graph is its
  first provider.

## 1. Why a context protocol

MCP standardized how agents call **tools** and fetch **resources**. Nothing
standardizes how agents acquire **context**: retrieval scored across sources,
token budgets, provenance/citations, time-validity of facts, and memory
write-back. Today every agent hard-codes its own retrieval stack, so context
sources (docs indexes, org wikis, issue trackers, telemetry, knowledge
graphs) must integrate with each agent separately — the M×N problem MCP
solved for tools, unsolved for context.

MCP's own primitives don't fit this shape: a `resources/read` returns a blob
with no relevance score, no token cost, no provenance chain, no validity
interval, and no way for the host to say "here is my budget and my goal —
give me your best frames." OCP is that missing contract. It deliberately
rides MCP's transport and lifecycle conventions (JSON-RPC 2.0, stdio +
streamable HTTP, initialize/capabilities handshake) so the ecosystem's
existing plumbing, inspectors, and mental models carry over — the delta is
the method vocabulary and the frame schema, not a new wire universe.

Vision note: this is the vendor-neutral trust play from `docs/VISION.md`
executed in the open — if OCP wins adoption, "graph-grounded, cited,
time-aware context" becomes a commodity *interface* whose best *backend*
Oxagen can sell, without the OSS binary depending on Oxagen for anything.

## 2. The local context plane (product)

### 2.1 What ships in the base binary

| Component | Implementation | Notes |
|---|---|---|
| Knowledge graph | SQLite property graph (typed nodes/edges) in `<ws>/.oxagen/context.db` | Bi-temporal fact edges; supersede-not-delete |
| Embedding index | `sqlite-vec` in the same file; optional in-memory HNSW accelerator | Fingerprinted per embedder; byte-compat skip on re-embed |
| Local embedder | ONNX Runtime, small open model (bge-small-class), weights fetched on first use, checksum-pinned | Fully offline after first fetch; `Embedder` trait allows API embedders (Z.ai embedding endpoint, OpenAI, Gemini) as opt-in alternates |
| Code graph | tree-sitter symbol/import indexer (`oxagen-graph`) | A built-in OCP provider |
| Episodic memory | Episode summaries, salience scoring, rule-promotion candidates | Local port of the TS memory concepts |
| Git history provider | Blame/log/co-change signals as context frames | Built-in provider |

### 2.2 Knowledge-graph schema (initial vocabulary)

Node kinds: `File`, `Symbol` (function/type/module), `Concept`, `Fact`,
`Episode` (one agent turn/session summary), `Person` (git author), `Artifact`
(generated media/docs), `Task`. Edge kinds: `DEFINES`, `IMPORTS`, `CALLS`,
`MENTIONS`, `DERIVED_FROM`, `SUPERSEDES`, `TOUCHED_IN` (symbol↔episode),
`CO_CHANGED` (file↔file, weighted), `ABOUT` (fact↔anything), `CITES`.

Fact edges carry bi-temporal validity — `valid_from`/`valid_to` (when true in
the world) and `recorded_at`/`superseded_at` (when we learned it). A
correction closes the old interval and writes a new edge with a `SUPERSEDES`
link; history is never destroyed. Queries default to "currently valid" with
an `as_of` escape hatch.

Extraction is conservative by default: the graph grows from (a) deterministic
indexing (code, git), (b) episode write-back after turns (summary + touched
symbols), and (c) explicit user writes (`oxagen context remember ...`).
LLM-driven fact extraction from arbitrary files exists but is opt-in
per-workspace — a wrong "fact" silently steering future turns is worse than a
missing one.

### 2.3 Retrieval pipeline (hybrid, budgeted, cited)

1. Query classification → which providers, which frame kinds.
2. Fan-out to capability-matching providers with the goal text + embedding.
3. Per-provider candidate lists → reciprocal-rank fusion across vector
   similarity, graph proximity (personalized-PageRank-lite from anchor
   nodes: open files, mentioned symbols), recency, and salience.
4. Dedup by content hash; diversity pass (max-marginal-relevance).
5. Budget packing: frames declare `token_cost`; pack to the engine's budget;
   emit what was dropped (never silent).
6. Assembly into the prompt with stable citation ids; the `ContextRecall`
   event reports the mix (which providers, how many tokens) so the TUI and
   trace can show *why the agent knew that*.

Latency budget: p95 < 100ms for the full pipeline on a 100k-chunk index
(`01-product-spec.md` §6) — retrieval must be cheap enough to run **every
turn** without the user noticing.

### 2.4 CLI surface

```
oxagen context status            # store size, embedder fingerprint, providers
oxagen context index [path]     # (re)index; incremental by default
oxagen context search "query"   # hybrid retrieval, human-readable frames
oxagen context remember "fact"  # explicit fact write
oxagen context forget <id>      # supersede a fact
oxagen graph query "cypher-ish" # direct graph queries (neighbors, paths)
oxagen graph viz [--out svg]     # render neighborhood via oxagen-media SVG
oxagen ocp list|add|remove|test  # manage external OCP providers
```

Agent tools mirror these: `context_search`, `context_remember`,
`graph_query` are in the default toolset, so the model itself can consult
and grow the graph mid-task.

## 3. The Open Context Protocol (specification outline)

Protocol version string: `ocp/1.0-draft` until the public repo ships;
`ocp/1.0` frozen at v1.0 release. The normative spec text lives in the
public repo under `spec/` (CC-BY-4.0), with `ocp-types` as the reference
binding. What follows fixes the shape.

### 3.1 Design goals

1. **MCP-adjacent, not MCP-dependent.** Same transports (stdio, streamable
   HTTP), same JSON-RPC 2.0 framing, same initialize/capability handshake
   pattern. A process may serve MCP and OCP simultaneously on one socket;
   namespacing keeps them distinct (`context/*`, `embeddings/*`, `graph/*`).
2. **Frames, not blobs.** The unit of exchange is a typed `ContextFrame`
   with relevance, cost, provenance, and validity — everything a budgeting,
   citing host needs to compose sources honestly.
3. **Budget-aware by contract.** Every query carries `max_tokens` and every
   frame carries `token_cost`; a conforming provider never returns more than
   the budget and never lies about cost (conformance-tested).
4. **Provenance mandatory, trust optional.** Every frame names its source
   chain; hosts decide what to trust. Frames are data — a conforming host
   never executes frame content, and prompt-assembly must delimit frames as
   quoted material, never as instructions.
5. **Time-aware.** Frames may carry validity intervals; queries may pin
   `as_of`.
6. **Write-back is part of the protocol.** Memory is context flowing the
   other way; `context/upsert` makes providers useful as memories, not just
   indexes.
7. **Small core, honest extensions.** Four required methods; everything else
   is negotiated capability. Experimental methods live under `x-<vendor>/*`.

### 3.2 Lifecycle & discovery

- Handshake: `initialize` → `{ protocolVersion, capabilities, provider:
  { name, version, dataFlow } }`. `dataFlow` declares `reads` (what it can
  see from queries), `writes` (whether it persists upserts), and `egress`
  (whether anything leaves the local machine) — hosts surface this at
  install/consent time.
- Capabilities: `{ query: { kinds: [...], filters: [...] }, upsert: bool,
  graph: bool, embeddings: { fingerprint }, subscribe: bool }`.
- Local providers: child processes over stdio, declared in
  `<ws>/.oxagen/ocp.toml` or `~/.config/oxagen/ocp.toml` (same layered model
  as MCP client configs). Remote providers: streamable HTTP + bearer/OAuth.

### 3.3 Core methods

| Method | Req/Opt | Shape |
|---|---|---|
| `initialize` | required | handshake above |
| `context/query` | required | `{ goal, query_text?, embedding?, kinds?, filters?, anchors?: [uri], max_frames, max_tokens, as_of? }` → `{ frames: [ContextFrame], truncated: bool, dropped_estimate? }` |
| `context/upsert` | optional | `{ deltas: [FrameDelta] }` → `{ receipts }` — episodic writes, fact assertions, supersessions |
| `context/subscribe` | optional | server-initiated frame invalidation/refresh notifications |
| `embeddings/embed` | optional | `{ texts: [...] }` → `{ fingerprint, vectors }` — lets a provider BE an embedder |
| `graph/query` | optional | `{ op: neighbors\|path\|subgraph\|search, params }` → nodes+edges with labels (human-readable `display_name` mandatory — raw ids are never the primary identifier) |
| `graph/mutate` | optional | typed node/edge upserts with bi-temporal semantics |

### 3.4 `ContextFrame` (the schema that matters)

```jsonc
{
  "id": "frm_…",                    // provider-scoped, stable for dedup
  "kind": "snippet|symbol|fact|doc|memory|episode|graph",
  "title": "human label",           // NEVER a bare uuid
  "content": "…",                    // text the host may quote into a prompt
  "uri": "file:///… | https://… | graph://…",
  "score": 0.83,                     // provider-normalized [0,1]
  "token_cost": 412,                 // honest, conformance-audited
  "valid_from": "2026-01-01T00:00:00Z",  // optional bi-temporal validity
  "valid_to": null,
  "recorded_at": "2026-07-10T…",
  "provenance": [                    // ordered chain, closest-to-source first
    { "type": "file", "uri": "file:///…", "range": "L120-160", "digest": "sha256:…" },
    { "type": "derivation", "method": "tree-sitter/symbol-extract", "by": "oxagen-graph/1.0" }
  ],
  "citation_label": "workspace.ts L120-160",
  "embedding": { "fingerprint": "…", "vector": null },  // optional; vector elidable
  "relations": [ { "rel": "DEFINES", "target_uri": "graph://sym/…" } ]
}
```

### 3.5 Security model (normative for hosts)

- Providers are quarantined: no inherited env credentials, no ambient
  workspace fs access — a provider sees exactly the query payload and what
  it indexed through its own declared inputs.
- `egress: true` providers require explicit one-time user consent naming
  what data flows out; hosts MUST NOT auto-enable them.
- Frame content is untrusted data. Conforming hosts delimit it in prompts as
  quoted material with source labels and MUST NOT treat frame text as
  instructions (prompt-injection posture is a host conformance item, not
  just guidance).
- Frames may be signed (optional detached signature over content+provenance)
  for supply-chain-sensitive deployments; verification is a host capability.

### 3.6 Conformance & adoption strategy

- `ocp-conformance` ships host-side and provider-side suites plus
  `ocp-inspect` (interactive prober, MCP-inspector-analog). "OCP conformant"
  means green on the suite for your declared capability set — the claim is
  checkable, which is what makes third-party adoption safe.
- Reference SDKs: Rust (`ocp-types`/`ocp-host`), TypeScript, and Python
  provider kits (thin: JSON-RPC + schema types + a 50-line example provider).
- Seed providers at launch (in the public repo): code-graph (built-in),
  git-history (built-in), `ocp-docs` (index a docs folder), `ocp-github`
  (issues/PRs as frames, egress-flagged) — enough that a second host could
  adopt OCP and immediately have four useful sources.
- The spec process: lives in the public repo, RFC-style issues, versioned
  drafts, no foundation ceremony until there are ≥2 independent hosts.

## 4. Embedder policy

- Default: local ONNX small-model (bge-small-class, ~130MB), fetched on
  first use from a pinned URL with sha256 verification into
  `~/.cache/oxagen/models/`, then fully offline. Rationale: zero keys →
  working context plane; benchmarkable determinism; no per-token cost.
- Alternates (config): Z.ai embeddings API, OpenAI, Gemini, Ollama — chosen
  via the same role-routing table as chat models (`07-model-matrix.md` §4).
- The `EmbedderFingerprint` (model, revision, dims, normalization) is stored
  with every vector; mixed-fingerprint retrieval is a hard error; embedder
  changes trigger incremental re-embedding (on-touch), and byte-identical
  content under the same fingerprint is never re-embedded.

## 5. What this is NOT (scope fences)

- Not a vector database — the plane *uses* one (sqlite-vec); it doesn't
  compete with hosted vector stores, and OCP lets you plug those in instead.
- Not RDF/SPARQL — property graph with a small typed vocabulary; oxigraph
  interop can arrive later as an external provider if demanded.
- Not a sync service — no multi-device sync in the base binary; that is
  exactly the kind of optional external OCP provider oxagen.sh (or anyone)
  might sell.
- Not an auto-RAG-everything — indexing beyond code/git/episodes is opt-in
  per source; the default posture is precision over recall.
