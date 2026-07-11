# Oxagen Rust CLI — Architecture

## 1. Design principles

1. **Ports, not concretions.** The engine (`oxagen-core`) never imports a
   provider SDK, a filesystem call, or a terminal library directly. It drives
   through traits (`Provider`, `Workspace`, `ContextPlane`, `Trace`) — the
   same seam discipline as the TS engine's `ports.ts`, carried over directly
   (see `packages/agent-engine/src/ports.ts` for the shape being ported).
2. **No `unsafe` outside FFI boundaries** (the local-model `llama.cpp`
   binding and the ONNX-runtime embedding binding are the two legitimate
   exceptions; isolate each behind a narrow, fully-tested wrapper and
   document every `unsafe` block).
3. **Async everywhere I/O happens** (`tokio`), sync/pure everywhere logic
   happens (the step-driver's decision logic, compaction, budget eviction,
   loop detection, graph traversal, and context-frame assembly are plain
   synchronous functions over owned data — easy to property-test).
4. **Serde-first.** Every cross-boundary type (provider request/response,
   tool call/result, trace event, context frame, OCP message) derives
   `Serialize`/`Deserialize` and is versioned. This is what makes golden-
   trajectory replay and protocol stability possible.
5. **Fail loud, recover gracefully.** Provider errors, tool errors, and
   malformed model output are typed (`thiserror`), never `panic!` in the hot
   path; the step-driver treats retryable vs. terminal errors distinctly.
6. **One storage engine.** Everything persistent (knowledge graph, vectors,
   memory, fleet ledger, trace index) lives in embedded SQLite (`rusqlite`,
   bundled) — one WAL, one backup story, one file format to document, one
   teardown path to get right on signal exit (`09-lessons-learned.md` L-L1).
   No DuckDB, no second embedded database, ever, without an ADR.
7. **Protocols outlive internals.** Anything a third party can integrate with
   (OCP, MCP, `--output-format stream-json`, trace JSONL) is versioned and
   conformance-tested; internal crate APIs may churn freely behind them.

## 2. Crate layout (Cargo workspace)

```
crates/
├── oxagen-protocol/    # serde types shared by every crate: events, tool
│                        # schemas, trace records, provider request/response
│                        # envelopes. Zero logic, zero I/O. The stability
│                        # contract of the whole workspace.
├── ocp-types/           # Open Context Protocol wire types (context frames,
│                        # queries, capabilities, provenance). MIT, published
│                        # to crates.io independently — other tools depend on
│                        # this WITHOUT taking any oxagen code. Zero deps
│                        # beyond serde. See 06-context-protocol.md.
├── ocp-host/            # OCP host runtime: provider discovery, stdio/http
│                        # transports, capability negotiation, routing,
│                        # budget accounting, consent gating for remote
│                        # providers. Used by oxagen-context; usable by any
│                        # other Rust agent that wants OCP support.
├── ocp-conformance/     # Public conformance suite (host- and provider-side)
│                        # + a `ocp-inspect` debugging binary, analogous to
│                        # MCP's inspector.
├── oxagen-core/         # The step-driver: one model call per step, message
│                        # accumulation, retry+backoff, context compaction,
│                        # tool-output budget+eviction, loop detection,
│                        # malformed-call repair, rules engine, hooks engine.
│                        # NO I/O of its own — drives through traits.
├── oxagen-tools/        # Workspace trait impl: fs (read/write/edit with
│                        # fuzzy-match diagnostics), ripgrep-backed grep/glob,
│                        # diff, process exec with real process-group signal
│                        # handling (`nix` + `tokio::process`).
├── oxagen-model/        # Provider trait + adapters: Z.ai (GLM 5.2 — chat,
│                        # embeddings, CogView, CogVideoX), Anthropic, OpenAI
│                        # (chat, gpt-image, Sora), Gemini direct (chat,
│                        # Imagen, Veo), xAI, Bedrock, Vertex, OpenRouter,
│                        # generic OpenAI-compatible, local GGUF via
│                        # llama.cpp FFI. Owns per-vendor streaming/SSE
│                        # parsing, tool-call dialect translation, reasoning-
│                        # effort mapping, model-catalog refresh, retry
│                        # classification. See 07-model-matrix.md.
├── oxagen-context/      # THE CONTEXT PLANE. Knowledge graph (bi-temporal
│                        # property graph), embedding index, episodic memory,
│                        # hybrid retrieval (vector + graph expansion),
│                        # context-frame assembly + token budgeting. Embeds
│                        # ocp-host and exposes every source — built-in or
│                        # external — through one uniform interface.
│                        # See 06-context-protocol.md.
├── oxagen-graph/        # Code-graph indexer: tree-sitter parsers (native,
│                        # not WASM), symbol + import-edge extraction,
│                        # incremental re-index on file change. Implemented
│                        # AS a built-in OCP provider feeding oxagen-context
│                        # — the protocol's first proof of non-triviality.
├── oxagen-media/        # Multimodal generation: image, SVG (generate →
│                        # validate → repair → optimize → preview), video
│                        # (async job polling), terminal preview (kitty/
│                        # iTerm2/sixel), cost gates. See 08-multimodal.md.
├── oxagen-pipeline/     # evaluate → enhance → route → execute → judge →
│                        # revise orchestration; verifyWork evidence gate;
│                        # best-of-N candidate generation + selection.
├── oxagen-fleet/        # Multi-agent: planner DAG, git-worktree isolation,
│                        # commit ledger (SQLite), PR/CI monitor.
├── oxagen-mcp/          # MCP *client* — external MCP servers' tools into
│                        # the engine's tool registry (stdio + streamable
│                        # http).
├── oxagen-tui/          # ratatui REPL: event-log rendering, diff view,
│                        # slash menu, HUD, panels. Maps 1:1 onto
│                        # oxagen-protocol's event vocabulary — never touches
│                        # the engine directly. TUI behavior requirements
│                        # (mouse-off default for native copy, paste chips,
│                        # line-exact scroll clipping) are binding via
│                        # 09-lessons-learned.md L-T*.
└── oxagen-cli/          # `clap` command tree; the actual `oxagen` binary.
                         # run / gen / graph / models / config / init /
                         # fleet / mcp / context, `--output-format
                         # text|json|stream-json`.
```

Each crate publishes independently to crates.io once stable. `ocp-types` /
`ocp-host` / `ocp-conformance` are the industry-facing artifacts and follow
their own (stricter) semver discipline from the first public release.

## 3. Core traits (the port boundary)

Sketch (final signatures land during Phase 1; this fixes the *shape*):

```rust
// oxagen-protocol
pub trait Provider: Send + Sync {
    async fn stream(&self, req: ModelRunRequest) -> Result<ModelStream, ProviderError>;
    async fn generate_object<T: DeserializeOwned>(&self, req: ObjectRunRequest) -> Result<ObjectRunResult<T>, ProviderError>;
}

pub trait Workspace: Send + Sync {
    async fn read_file(&self, path: &Path, range: Option<LineRange>) -> Result<String, ToolError>;
    async fn write_file(&self, path: &Path, content: &str) -> Result<(), ToolError>;
    async fn edit_file(&self, path: &Path, old: &str, new: &str, replace_all: bool) -> Result<EditOutcome, ToolError>;
    async fn exec(&self, cmd: &str, timeout: Duration, signal: Option<CancellationToken>) -> Result<ExecOutcome, ToolError>;
    async fn grep(&self, pattern: &str, opts: GrepOpts) -> Result<Vec<GrepMatch>, ToolError>;
    async fn glob(&self, pattern: &str) -> Result<Vec<PathBuf>, ToolError>;
    async fn diff(&self) -> Result<String, ToolError>;
}

// The context plane — one trait, many sources behind it (06-context-protocol.md)
pub trait ContextPlane: Send + Sync {
    /// Hybrid retrieval: returns budgeted, provenance-carrying frames.
    async fn query(&self, q: ContextQuery) -> Result<Vec<ContextFrame>, ContextError>;
    /// Writes: episodic memory, extracted facts, graph mutations.
    async fn upsert(&self, delta: ContextDelta) -> Result<UpsertReceipt, ContextError>;
    /// Direct graph access for graph-shaped questions (neighbors, paths).
    async fn graph(&self, q: GraphQuery) -> Result<GraphResult, ContextError>;
}

pub trait Embedder: Send + Sync {
    fn fingerprint(&self) -> EmbedderFingerprint; // model id + revision + dims + normalization
    async fn embed(&self, texts: &[String]) -> Result<Vec<Embedding>, EmbedError>;
}

pub trait MediaProvider: Send + Sync {
    fn capabilities(&self) -> MediaCapabilities; // image? video? edit? sizes? cost table?
    async fn generate_image(&self, req: ImageRequest) -> Result<MediaArtifact, MediaError>;
    async fn generate_video(&self, req: VideoRequest) -> Result<MediaJob, MediaError>; // async job
    async fn poll_video(&self, job: &MediaJob) -> Result<MediaJobStatus, MediaError>;
}

pub trait Trace: Send + Sync {
    fn record(&self, event: TraceEvent);
}
```

`oxagen-core::Engine::run_turn(...)` drives through `&dyn Provider`,
`&dyn Workspace`, `&dyn ContextPlane`, `&dyn Trace` and is the single
entrypoint every caller (one-shot CLI, interactive TUI, fleet worker, library
consumer) uses. This is the direct Rust analog of `runTurn`/`runCodingAgent`
in `packages/agent-engine/src/pipeline/index.ts`. **There is exactly one
engine and one stage vocabulary** — the TS era's duplicated `StageKind`
(engine copy + CLI `trace.ts` copy) is the canonical example of the defect
class principle #7 exists to prevent (`09-lessons-learned.md` L-E1).

## 4. Event vocabulary (protocol)

Events are plain Rust enum variants flowing over a `tokio::sync::mpsc`
channel from `oxagen-core` to whichever renderer (`oxagen-tui` or the JSON
serializer in `oxagen-cli`) is listening. `--output-format stream-json` is a
`serde_json` serialization of this exact enum, one line per event — a stable,
versioned machine interface.

```rust
pub enum AgentEvent {
    Stage { name: StageKind },
    Text { delta: String },
    Reasoning { delta: String },
    ToolStart { call_id: String, name: String, input: serde_json::Value },
    ToolResult { call_id: String, output: ToolOutput, duration_ms: u64 },
    FileChange { path: PathBuf, kind: FileChangeKind, diff: Option<UnifiedDiff> },
    ContextRecall { frames: Vec<ContextFrameRef>, provider_mix: Vec<ProviderShare>, tokens: u32 },
    ContextWrite { receipt: UpsertReceipt },
    MediaProgress { artifact_id: String, kind: MediaKind, state: MediaJobState },
    MediaComplete { artifact: MediaArtifactRef },
    Retry { attempt: u32, reason: String },
    Compaction { before_tokens: u64, after_tokens: u64 },
    BudgetTick { spent_usd: f64, limit_usd: Option<f64>, mode: BudgetMode },
    JudgeVerdict { passed: bool, evidence: JudgeEvidence },
    ScopeReview { proposal: ScopeProposal }, // interactive gate before large plans execute
    Commit { sha: String, message: String },
    Pr { url: String, status: PrStatus },
    Complete { result: TurnResult },
    Error { error: EngineError, retryable: bool },
}
```

`FileChange` carries the diff so the TUI's files-touched panel renders
per-edit diffs without a second data path (`09-lessons-learned.md` L-T5:
in TS, the `onFileEdit` callback had to be patched into two pipeline
switches — here there is one emission point by construction).

## 5. Data flow of one turn

```
user prompt
  → triage (oxagen-model, triage role): task class, single-task fast path?
  → context recall (oxagen-context): hybrid retrieval across built-in
    providers (code graph, memory, git history) + external OCP providers,
    assembled into budgeted ContextFrames with provenance      [ContextRecall]
  → plan (worker role; SKIPPED on classified simple prompts)   [Stage]
  → scope review gate (interactive only, above thresholds)     [ScopeReview]
  → execute loop: model step ↔ tool calls                      [ToolStart/…]
      bash / fs tools / mcp tools / media tools / context tools
  → judge (judge role, judge≠worker; skipped on fast paths)    [JudgeVerdict]
  → context write-back: episode summary, extracted facts,
    file-symbol touch counts → knowledge graph                 [ContextWrite]
  → complete                                                    [Complete]
```

Every stage boundary emits an event; the budget meter ticks on every
provider/media call; nothing user-visible is derived from internal state that
isn't also in the event stream (that discipline is what makes headless mode,
`stream-json`, replay, and the TUI provably equivalent).

## 6. On-disk layout

```
~/.config/oxagen/
├── config.toml            # provider defaults, model role assignments,
│                           # media defaults, telemetry opt-in flag
├── credentials.toml        # optional provider keys (0600), if the user
│                           # prefers file storage over env vars
└── catalog/                # cached provider model catalogs (refreshable,
                            # checked into neither git nor backups)

~/.cache/oxagen/
└── models/                 # embedding model weights (ONNX), checksum-pinned,
                            # fetched on first use — never bundled in binary

<workspace>/.oxagen/
├── rules/                  # Tier-1/Tier-2 workspace rules (.md)
├── skills/                 # skill.md files (ADR-008 filesystem-first)
├── ocp.toml                # external context providers for this workspace
├── context.db              # SQLite: knowledge graph (nodes/edges, bi-temporal),
│                           #   embedding index (sqlite-vec), episodic memory,
│                           #   code-graph symbols — ONE file, ONE engine
├── trace/*.jsonl           # per-run trajectory logs
├── artifacts/              # generated media (images/svg/video) + manifest
└── ledger.db               # SQLite: fleet commit ledger
```

Storage decisions, binding:

- **SQLite everywhere** (`rusqlite` with the bundled feature; statically
  linked). Vectors via **`sqlite-vec`** statically linked; an in-memory HNSW
  accelerator (`usearch` or `hnsw_rs`) may be built at load time for indexes
  past a size threshold, but the durable format is the SQLite file.
- **The embedding index is fingerprinted** (`EmbedderFingerprint`: model id,
  revision, dimensions, normalization). Retrieval never mixes fingerprints;
  changing the embedder invalidates incrementally (re-embed on next touch),
  and byte-identical content under the same fingerprint is never re-embedded
  (`09-lessons-learned.md` L-C2 — the TS code-graph's byte-compat skip).
- **Bi-temporal facts:** graph fact edges carry `valid_from/valid_to` and
  `recorded_at/superseded_at`; supersession closes intervals, never deletes
  (`09-lessons-learned.md` L-C3).
- No global daemon, no background network listener. The code-graph watcher is
  an in-process `notify` task alive only while a session runs.

## 7. The context plane (summary — full spec in 06-context-protocol.md)

`oxagen-context` is the single door between the engine and *everything the
agent knows that isn't in the prompt*: code structure, prior episodes,
extracted facts, git history, and any external source. Internally it hosts
N providers — built-ins linked into the binary (code graph, memory, git) and
externals spoken to over OCP (stdio child processes or remote HTTP) — and
does four jobs the providers themselves never do:

1. **Routing & fusion:** fan a `ContextQuery` to capability-matching
   providers, fuse results (reciprocal-rank fusion over vector similarity +
   graph proximity + recency), dedup by content hash.
2. **Budgeting:** every frame carries `token_cost`; assembly packs to the
   caller's budget and reports what was dropped — silent truncation is
   banned (the engine's compaction lesson applied to retrieval).
3. **Provenance:** every frame that reaches a prompt carries its source
   chain; every citation the model emits can be traced to a frame. UI-facing
   identifiers are human labels, never raw ids.
4. **Consent & isolation:** external providers declare data-flow direction
   (`read`, `write`, `egress`) at install; a provider that could send
   workspace content off-machine requires explicit one-time consent naming
   what leaves. Providers run as child processes with no inherited
   credentials and no ambient workspace filesystem access — they receive
   only what the query hands them.

## 8. Security model

- Credentials never logged, never in trace JSONL, never forwarded to OCP/MCP
  child processes (redact by type: the credential resolver returns a
  `SecretString` with no `Display`).
- `edit_file`/`write_file`/`exec` respect a workspace-root jail by default
  (no traversal outside the project root without `--unsafe-full-fs`).
  **File tools resolve against the session's pinned workspace root, and a
  `bash cd` or worktree switch cannot silently diverge the two** — the TS
  CLI shipped that bug twice (`09-lessons-learned.md` L-S2).
- `exec` timeout + process-group kill is native (`killpg` / job objects).
- **Signal exit is orderly:** signal handlers request cancellation, drain the
  event channel, close SQLite/ONNX/llama.cpp handles, *then* exit. Calling
  `process::exit` from a handler while native libraries hold locks aborted
  the TS CLI (`09-lessons-learned.md` L-L1); the Rust design makes it
  structurally hard by owning all native handles in a single shutdown-aware
  runtime struct.
- Media artifacts are written under `.oxagen/artifacts/` with a manifest;
  the agent cannot overwrite arbitrary paths via a generation tool.
- Dependency policy: `cargo deny` (license allowlist, no GPL/AGPL/SSPL
  transitively) + `cargo audit` on every push.

## 9. Why this repo, then a mirror (unchanged from rev 1)

Building inside `oxagen-platform/crates/` first — the existing
`bench/swe-bench` Harbor harness, CI, and the TS golden-trajectory oracle
live here and are the fastest path to real resolve-rate numbers. Once Phase 3
exit criteria are met, a one-way `git subtree split` export creates the
public repo, which becomes the source of truth; the monorepo copy is deleted
(see `03-plan.md`).
