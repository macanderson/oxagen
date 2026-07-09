# Oxagen Rust CLI — Architecture

## 1. Design principles

1. **Ports, not concretions.** The engine (`oxagen-core`) never imports a
   provider SDK, a filesystem call, or a terminal library directly. It drives
   through traits (`Provider`, `Workspace`, `Memory`, `Trace`, `CodeGraph`) —
   the same seam discipline as the TS engine's `ports.ts`, carried over
   directly (see `packages/agent-engine/src/ports.ts` for the shape being
   ported).
2. **No `unsafe` outside FFI boundaries** (the local-model `llama.cpp`
   binding is the one legitimate exception; isolate it behind a narrow,
   fully-tested wrapper crate/module and document every `unsafe` block).
3. **Async everywhere I/O happens** (`tokio`), sync/pure everywhere logic
   happens (the step-driver's decision logic, compaction, budget eviction,
   loop detection are plain synchronous functions over owned data — easy to
   property-test, no `Send`/`Sync` ceremony needed).
4. **Serde-first.** Every cross-boundary type (provider request/response,
   tool call/result, trace event, protocol message) derives
   `Serialize`/`Deserialize` and is versioned. This is what makes golden-
   trajectory replay and future protocol stability possible.
5. **Fail loud, recover gracefully.** Provider errors, tool errors, and
   malformed model output are typed (`thiserror`), never `panic!` in the hot
   path; the step-driver treats retryable vs. terminal errors distinctly
   (mirrors TS Phase-1 retry/backoff design in `docs/specs/cli-swe-bench/03-plan.md`).

## 2. Crate layout (Cargo workspace)

```
crates/
├── oxagen-protocol/    # serde types shared by every crate: events, tool
│                        # schemas, trace records, provider request/response
│                        # envelopes. Zero logic, zero I/O. The stability
│                        # contract of the whole workspace.
├── oxagen-core/         # The step-driver: one model call per step, message
│                        # accumulation, retry+backoff, context compaction,
│                        # tool-output budget+eviction, loop detection,
│                        # malformed-call repair, rules engine, hooks engine,
│                        # local SQLite-backed memory. NO I/O of its own —
│                        # drives entirely through the `Provider`/`Workspace`/
│                        # `Memory`/`Trace` traits from oxagen-protocol.
├── oxagen-tools/        # Workspace trait impl: fs (read/write/edit with
│                        # fuzzy-match diagnostics), ripgrep-backed grep/glob
│                        # (shells to `rg` if present, falls back to an
│                        # in-process `grep` crate walk), diff (`similar` or
│                        # `git2`), process exec with real process-group
│                        # signal handling (`nix` + `tokio::process`).
├── oxagen-model/        # Provider trait + concrete adapters: Anthropic,
│                        # OpenAI, Bedrock (aws-sdk-bedrockruntime), Vertex
│                        # (hand-rolled REST client over `reqwest`+`hyper`,
│                        # or `google-cloud-rust` if mature enough at build
│                        # time), OpenRouter, generic OpenAI-compatible
│                        # (covers Ollama/vLLM/LM Studio), local GGUF via
│                        # llama.cpp FFI. Owns per-vendor streaming/SSE
│                        # parsing, tool-call schema translation, reasoning-
│                        # effort mapping, retry-on-transport-error.
├── oxagen-graph/        # Code-graph context engine: tree-sitter parsers
│                        # (native crate per language, not WASM), symbol +
│                        # import-edge index, local embedding + vector index
│                        # (candle or ONNX Runtime for embeddings; `hnsw_rs`/
│                        # `usearch` for the vector index), persisted to a
│                        # local SQLite/DuckDB file per workspace (no server).
├── oxagen-pipeline/     # evaluate → enhance → route → execute → judge →
│                        # revise orchestration; verifyWork evidence gate;
│                        # best-of-N candidate generation + selection.
├── oxagen-fleet/        # Multi-agent: planner DAG, git-worktree isolation,
│                        # commit ledger (SQLite), PR/CI monitor (shells to
│                        # `gh` or hits GitHub REST via `octocrab`).
├── oxagen-mcp/          # MCP *client* — connect to external MCP servers
│                        # (stdio + streamable-http transports) and expose
│                        # their tools into the engine's tool registry.
├── oxagen-tui/          # ratatui-based interactive REPL: streaming render,
│                        # diff view, slash-command menu, HUD, mouse
│                        # selection — maps 1:1 onto oxagen-protocol's event
│                        # vocabulary so it never touches the engine directly.
└── oxagen-cli/          # `clap`-based command tree; the actual `oxagen`
                         # binary. Wires config, credential resolution, one-
                         # shot / interactive / fleet entrypoints, `--output-
                         # format text|json|stream-json`, init/scaffolding.
```

Each crate publishes independently to crates.io once stable (`oxagen-core`
and `oxagen-tools` are useful standalone to other Rust agent projects — this
is deliberate, matches non-negotiable #3 in the product spec about library
usability).

## 3. Core traits (the port boundary)

Sketch (final signatures land during Phase 1 implementation; this fixes the
*shape*, ported directly from `packages/agent-engine/src/ports.ts`):

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

pub trait Memory: Send + Sync {
    async fn recall_context(&self) -> Result<String, MemoryError>;
    async fn remember(&self, kind: &str, content: serde_json::Value, status: Option<&str>) -> Result<(), MemoryError>;
}

pub trait CodeGraph: Send + Sync {
    async fn query(&self, req: GraphQuery) -> Result<GraphResult, GraphError>;
}

pub trait Trace: Send + Sync {
    fn record(&self, event: TraceEvent);
}
```

`oxagen-core::Engine::run_turn(providers: &dyn Provider, workspace: &dyn
Workspace, memory: &dyn Memory, graph: &dyn CodeGraph, trace: &dyn Trace, ...)`
is the single entrypoint every caller (one-shot CLI, interactive TUI, fleet
worker, library consumer) drives through. This is the direct Rust analog of
`runTurn`/`runCodingAgent` in `packages/agent-engine/src/pipeline/index.ts`.

## 4. Event vocabulary (protocol)

Ported from the existing boundary spec (`docs/specs/cli-swe-bench/04-rust-port.md`
§"Boundary"), now internal trait-boundary events rather than a cross-process
JSON-over-stdio protocol (that transport was a *migration-period* device; the
shipped product is a single process, so events are plain Rust enum variants
flowing over a `tokio::sync::mpsc` channel from `oxagen-core` to whichever
renderer (`oxagen-tui` or the JSON serializer in `oxagen-cli`) is listening):

```rust
pub enum AgentEvent {
    Stage { name: String },
    Text { delta: String },
    Reasoning { delta: String },
    ToolStart { call_id: String, name: String, input: serde_json::Value },
    ToolResult { call_id: String, output: ToolOutput, duration_ms: u64 },
    FileChange { path: PathBuf, kind: FileChangeKind },
    Retry { attempt: u32, reason: String },
    Compaction { before_tokens: u64, after_tokens: u64 },
    JudgeVerdict { passed: bool, evidence: JudgeEvidence },
    Commit { sha: String, message: String },
    Pr { url: String, status: PrStatus },
    Complete { result: TurnResult },
    Error { error: EngineError, retryable: bool },
}
```

`--output-format stream-json` is a `serde_json` serialization of this exact
enum, one line per event — giving external tooling (CI scripts, dashboards,
the `bench/swe-bench` harness) a stable, versioned machine interface for free.

## 5. On-disk layout

```
~/.config/oxagen/
├── config.toml           # provider defaults, model aliases, telemetry opt-in flag
└── credentials.toml       # optional: provider keys (mode 0600), only if the user
                            #   chooses file storage over env vars / native chains

<workspace>/.oxagen/
├── rules/                 # Tier-1/Tier-2 workspace rules (.md), unchanged format
├── skills/                # skill.md files, unchanged format (ADR-008)
├── memory.db               # SQLite: episodic memory, salience, rule-promotion candidates
├── graph.db                 # SQLite/DuckDB: code-graph symbol/edge/embedding index
├── trace/*.jsonl           # per-run trajectory logs
└── ledger.db                # SQLite: fleet commit ledger (hash/branch/task/trace/files)
```

No global daemon, no background network listener. The code-graph "daemon"
concept (`ADR-016`) becomes an in-process incremental indexer with an
optional filesystem-watch task (`notify` crate) for interactive sessions —
started and stopped with the CLI process, not a persistent system service.

## 6. Security model

- Credentials never logged, never included in trace/trajectory JSONL (redact
  by type, not by best-effort string matching — the credential resolver
  returns a `SecretString`-wrapped value that intentionally has no `Display`).
- `edit_file`/`write_file`/`exec` respect a workspace-root jail by default
  (no path traversal outside the initialized project root without an explicit
  `--unsafe-full-fs` escape hatch, off by default) — this is *new* relative to
  the TS CLI and should be flagged in the risk register as a behavior change
  worth a migration note.
- `exec` timeout + process-group kill is native (`nix::sys::signal::killpg`
  and Windows job objects via `windows-sys` where applicable) — closes the
  TS CLI's documented bash-process-group leak on abort (`GAPS.md`/`01-gap-audit.md` P1).
- Dependency policy: `cargo deny` in CI enforces license allowlist (no GPL/
  AGPL/SSPL transitively) and a security-advisory check (`cargo audit`/
  `RustSec`) on every push.

## 7. Why this repo, then a mirror (not day-one public repo)

Building inside `oxagen-platform/crates/oxagen-cli` first — not a brand-new
public repo — because: (a) the existing `bench/swe-bench` + `bench/terminal-
bench` Harbor harness, CI, and ClickHouse eval dashboard already exist here
and are the fastest way to get a real resolve-rate number during
development; (b) the golden-trajectory oracle is the TS engine already in
this tree; (c) it keeps one CI, one review process, one place Mac's other
sessions can see the work in flight (per this repo's own operating-mode
rules). Once Phase 3 exit criteria are met (native bench parity, own CI
green, no dependency on the TS bench harness for day-to-day dev), a one-way
export script (`tools/scripts/export-oxagen-cli.sh`) splits `crates/
oxagen-cli/` history into the public `oxagen-cli` GitHub repo via `git
subtree split` (preserves commit history for the OSS project), and that
public repo becomes the source of truth going forward — the monorepo copy
is deleted, not kept as a second copy to maintain.
