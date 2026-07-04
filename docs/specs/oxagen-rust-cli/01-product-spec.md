# Oxagen Rust CLI — Product Spec

## 1. Mission

Build the fastest, most token-efficient, most capable open-source terminal
coding agent — installable in one command, usable with any model provider's
own keys, with no account, no telemetry-by-default, and no server dependency —
and make it demonstrably **#1 on SWE-bench Verified by more than 3 percentage
points** over the next-best publicly comparable agentic CLI at a fixed,
identical worker model (methodology in `04-benchmark-strategy.md` — this is a
scaffold claim, not a model claim, and every number we publish says so).

## 2. Non-negotiables (binding for every phase)

1. **No phone-home requirement.** `oxagen run` (the core one-shot/interactive
   coding loop) must complete a real task with zero network calls other than
   the one the user's configured model provider requires. No license check,
   no update ping (opt-in only, see §7), no mandatory account.
2. **BYOK, multi-provider, no gateway lock-in.** The binary talks directly to
   provider APIs. Users bring their own `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
   / AWS credentials (SigV4, standard credential chain) / GCP credentials
   (ADC) / OpenRouter key / a local Ollama or OpenAI-compatible base URL. No
   Oxagen-operated routing layer sits between the user and their model calls.
3. **Open source, permissive license, no CLA-gated contributions trap.**
   Apache-2.0 (engine/tools) + MIT (CLI/protocol) dual license, DCO-based
   contribution (`git commit -s`), no copyright assignment. Public repo,
   public issue tracker, public roadmap.
4. **Single static binary, sub-100ms cold start to first prompt render, no
   runtime dependency (no Node, no Python, no Docker required for the base
   product).** `musl` static linking on Linux; universal or per-arch binaries
   on macOS; no dynamic OpenSSL dependency (use `rustls`).
5. **Feature-complete relative to what makes today's CLI good as a coding
   agent** — not relative to its platform-integration surface. See the parity
   matrix in §5.
6. **Privacy by default.** Telemetry, if present at all, is anonymous,
   aggregate, and **opt-in** (not opt-out — this inverts the current
   TypeScript CLI's opt-out default, deliberately, because an OSS tool with a
   phone-home-by-default violates the trust this project depends on). Code,
   prompts, file contents, file paths, and API keys are never transmitted to
   Oxagen infrastructure by the OSS binary, full stop — not even in
   aggregate/anonymized telemetry.
7. **#1 on SWE-bench Verified by >3pp**, reproducible by a third party from
   the public repo with only a model API key, against the current best
   publicly documented comparable result at the time of the claim. See
   `04-benchmark-strategy.md` for exact methodology, refresh cadence, and the
   rules that keep this claim honest as competitors move.

## 3. Target users

- Individual developers who want a fast, scriptable, local-first coding agent
  and refuse to install Node/Python toolchains just to run a CLI.
- Teams that want to self-host / air-gap (BYOK to their own Bedrock/Vertex
  tenancy, no third-party SaaS in the loop) — this is the AWS/GCP Model Garden
  requirement: enterprises with existing Bedrock/Vertex spend and compliance
  posture want their coding agent billed through their own cloud account.
  CI/CD pipelines that need a fast, deterministic, JSON-first agent CLI
  (SWE-bench-style automated fixing, PR review bots, release-note generation)
  without a Node cold-start tax.
- OSS contributors who want to extend/embed the agent (crate-level API, not
  just a CLI binary) — `oxagen-core` and `oxagen-tools` must be usable as
  library crates by other Rust projects.

## 4. Provider model (BYOK, no gateway)

| Provider | Auth | Notes |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Direct Messages API, streaming, native tool-use, extended thinking. |
| OpenAI | `OPENAI_API_KEY` | Responses API (streaming, tool-use, reasoning effort param). |
| AWS Bedrock | Standard AWS credential chain (env, profile, IMDS, SSO) + region | `bedrock-runtime` `Converse`/`ConverseStream` API — covers both native Bedrock models (Claude, Titan, Llama, Nova) **and Bedrock Model Garden custom-imported models** by ARN. |
| Google Vertex AI | ADC (`GOOGLE_APPLICATION_CREDENTIALS` or workload identity) + project/region | Vertex `generateContent`/streaming — covers native Gemini **and Vertex Model Garden** (Llama, Mistral, Claude-on-Vertex, custom-deployed endpoints by endpoint ID). |
| OpenRouter | `OPENROUTER_API_KEY` | One key, any vendor's model behind OpenRouter's routing — useful as a zero-setup on-ramp for users without direct provider accounts. |
| Ollama / local OpenAI-compatible | none, or `--base-url` | vLLM, LM Studio, llama.cpp `server`, text-generation-inference — anything speaking the OpenAI chat/completions wire format. Fully offline capable. |
| Generic OpenAI-compatible | `--base-url` + optional bearer token | Escape hatch for any other vendor (Groq, Together, Fireworks, Mistral La Plateforme, DeepSeek, etc.) without a bespoke adapter. |

Selection: `oxagen config model set <provider>/<model-id>` persists a default;
`--model <provider>/<model-id>` overrides per-invocation; `oxagen models list`
enumerates known model ids per configured provider (a small curated catalog,
data-driven like today's `models.json`, not hard-coded per call site).
Credential resolution order: CLI flag → env var → provider-native config
(AWS profile / ADC file / `~/.config/oxagen/credentials.toml`) → interactive
prompt on first use (never silently fails with an opaque provider error).

No default model is billed through Oxagen. There is no `oxagen login`
requirement anywhere on the core coding path. (An *optional* `oxagen cloud
login` plugin may exist later purely for opt-in features like cross-device
memory sync to oxagen.sh — never required, always visibly separate, off by
default, and covered by its own explicit consent screen — but it is out of
scope for the initial OSS release and is not part of this spec's success
criteria.)

## 5. Feature parity matrix — keep / rebuild / cut

Derived from the TS CLI's actual command inventory (`apps/cli/GAPS.md`,
`apps/cli/README.md`) and engine internals (`packages/agent-engine`,
`apps/cli/src/agent/**`, `apps/cli/src/runtime/**`).

### KEEP — core agentic coding loop (the product)

| Capability | TS source (reference) | Rust target |
|---|---|---|
| Step-driver agent loop (evaluate→enhance→route→execute→judge→revise) | `packages/agent-engine/src/pipeline/index.ts`, `loop-driver.ts` | `oxagen-core` |
| Tool set: read_file (line numbers), write_file, edit_file (fuzzy-match failure feedback, replace_all), bash (middle-out truncation, signal-aware, timeout backstop), grep/glob (ripgrep-backed) | `packages/agent-engine/src/tools.ts` | `oxagen-tools` |
| Code-graph context engine: tree-sitter parse, symbol/import-edge index, semantic search, domain assist | `packages/code-graph/src/*`, `apps/cli/src/daemon/code-graph/*`, `apps/cli/src/agent/context/*` | `oxagen-graph` (native tree-sitter, no WASM) |
| Model router (cost/tier-aware) + rate card | `apps/cli/src/agent/model-router.ts`, `rate-card.ts` | `oxagen-model` |
| Multi-provider `AgentAi` port abstraction | `packages/agent-engine/src/ports.ts` | `oxagen-model::Provider` trait |
| Best-of-N candidate generation + selection (test signal + diff-judge) | `docs/specs/cli-swe-bench/02-spec.md` §5 | `oxagen-pipeline` |
| Evidence-based judge (diff + test-tail, judge≠worker) | same | `oxagen-pipeline` |
| Fleet / multi-agent orchestration: worktree isolation, planner DAG, commit ledger | `apps/cli/src/agent/fleet/*` | `oxagen-fleet` |
| Interactive REPL/TUI: streaming render, diff view, slash commands, HUD | `apps/cli/src/repl/*`, `apps/cli/src/tui/*` | `oxagen-tui` (ratatui) |
| On-device/local model runtime (GGUF via llama.cpp bindings) | `apps/cli/src/runtime/providers/on-device*.ts`, `runtime/provisioning/*` | `oxagen-model::local` (native `llama-cpp-2`/`llama.cpp` FFI, not a WASM bridge) |
| Memory (episodic recall/write, salience, promotion to rules) — **local-only, no server round-trip** | `apps/cli/src/agent/memory.ts`, `packages/engram/*` (concepts, not the ClickHouse-backed impl) | `oxagen-core::memory` backed by embedded SQLite/DuckDB, no ClickHouse dependency in OSS build |
| Workspace rules (`.oxagen/rules/`) — Tier-1 prompt injection + Tier-2 tool-gate guard | `apps/cli/src/rules/*` | `oxagen-core::rules` |
| Settings/hooks (Session/PreToolUse/PostToolUse) | `apps/cli/src/settings/*` | `oxagen-core::hooks` |
| Slash commands, skills (`.md`-defined) | `apps/cli/src/slash/*`, ADR-008 skills-filesystem-first | `oxagen-cli::slash`, filesystem-first unchanged |
| MCP client (connect to *external* MCP servers as tools) | `apps/cli/src/mcp/client.ts` | `oxagen-mcp` (rmcp or hand-rolled client over the official MCP Rust SDK) |
| PR/CI monitor (watch a PR to green, offer auto-merge) | `apps/cli/src/lib/pr-monitor.ts`, `gh-pr.ts` | `oxagen-fleet::pr_monitor` (shells to `gh` CLI or uses GitHub REST directly) |
| Init / project scaffolding (`.oxagen/` dir, rules seed) | `apps/cli/src/project/init.ts` | `oxagen-cli::init` |
| Config file + env var resolution | `apps/cli/src/lib/config.ts` | `oxagen-cli::config` (TOML, `~/.config/oxagen/config.toml`) |
| Trace/trajectory recording (JSONL, replay) | `apps/cli/src/agent/trace*.ts`, `verbose-log.ts` | `oxagen-core::trace` |
| `--output-format text|json|stream-json` machine-readable output | `apps/cli/src/repl/one-shot.ts` | `oxagen-cli` (first-class, not bolted on) |

### CUT — platform-bound, no home in an account-free OSS product

Everything whose entire purpose is talking to oxagen.sh: `org.*`,
`workspace.*`, `billing.*`, `plugin.*` (marketplace/registry/credential
commands), `document.*`/`documents.*` (server-side doc generation + PDF),
`image.*`/`video.*`/`svg.*` (server-side media generation), `agent mcp
register/list` (the *Oxagen platform's* MCP registry — connecting to
*external* MCP servers as tools stays, see KEEP), `agent task background *`
(server-managed background tasks), `conversation.*` (server-side chat
history), `automation.*` (server-side scheduled triggers), `api-key.*`
(Oxagen platform API keys), `notifications.*`, `privacy export/erase` (GDPR
endpoints against Oxagen's own data store — not applicable, there is no
Oxagen-held data), `skill workspace list` (server-synced skill catalog —
filesystem-first skills stay), `user preferences *`, `system install
instructions` (Oxagen MCP server connection instructions), telemetry's
platform-side ingest route (`v1/telemetry/usage`) and its opt-out-default
posture (inverted per non-negotiable #6 if kept at all), graph-sync-to-web-app
(`ADR-018`), Vercel AI Gateway routing, `streamAgentReply`/metered billing
path, Neo4j-backed cloud code-graph.

Rationale: these ~100+ commands exist to integrate the CLI with the Oxagen
SaaS. An account-free OSS product has no SaaS to integrate with. Users who
want that integration keep using `@oxagen/cli` (proprietary, unaffected by
this project).

### REBUILD DIFFERENTLY — same user value, different mechanism

| TS mechanism | Why it can't carry over as-is | Rust replacement |
|---|---|---|
| Vercel AI Gateway model routing | Gateway is an oxagen.sh-operated proxy | Direct per-provider SDK clients (`oxagen-model`), see §4 |
| `AI_GATEWAY_API_KEY` credential resolution | Same | Provider-native credential chains (env, AWS SDK default chain, GCP ADC, OpenRouter key, `--base-url`) |
| Login/OAuth+PKCE against oxagen.sh, `~/.config/oxagen/config.json` session | No account to log into | No login command in the base product; config file holds only provider keys/model defaults, never a session token |
| Telemetry to `POST /v1/telemetry/usage` (ClickHouse-backed, opt-out) | No Oxagen ingest endpoint to call by default | If retained at all: opt-in, points at a public, documented, self-hostable ingest (or removed entirely for v1 — see `03-plan.md` Phase 5 decision point) |
| Memory backed by `@oxagen/engram` (ClickHouse/DuckDB adapters tied to platform config) | Platform-coupled storage adapters | Embedded SQLite (via `rusqlite`) for episodic memory + rules; no ClickHouse dependency ships in the OSS binary |
| Code-graph sync to Neo4j (`ADR-018`, cloud graph) | Cloud-only, requires the platform | Local-only `oxagen-graph` index (tree-sitter + local vector index, e.g. `usearch` or `hnsw_rs`), no server sync |
| MCP server *hosted by* Oxagen (`mcp.oxagen.sh`) | N/A to a standalone binary | Not applicable — the CLI is an MCP *client* only in this product, connecting to whatever external MCP servers the user configures |

## 6. Success metrics (definition of done for "v1.0")

| Metric | Target | How verified |
|---|---|---|
| SWE-bench Verified resolve rate vs. best public comparable | **≥ +3.0 percentage points**, same pinned model | `bench/swe-bench` harness (Rust-adapted, see `04-benchmark-strategy.md`) |
| Cold start to first token | < 150ms process start, < 100ms of that pre-network | `hyperfine oxagen --version` / instrumented startup trace |
| Binary size (static, stripped) | < 40MB per platform target | CI artifact size check |
| Zero network calls with only a model key configured, no `--telemetry` flag | 0 calls other than the model API | Network-namespace/`strace`-gated integration test |
| Test coverage (workspace-wide) | ≥ 85% line coverage on `oxagen-core`/`oxagen-tools`/`oxagen-pipeline`, ratchet toward 90 | `cargo llvm-cov` in CI |
| Golden-trajectory parity with the frozen TS spec (migration period only) | 100% byte-identical event stream on recorded inputs | CI conformance suite, retired once the TS spec is fully ported |
| License scan | 0 GPL/AGPL/SSPL transitive dependencies | `cargo deny` in CI |
| Distribution | `cargo install`, Homebrew, `curl \| sh`, GH Releases (4 OS/arch combos) all green | Release CI job |

## 7. Explicitly out of scope for v1.0

- Windows-native TUI parity (ratatui supports Windows terminals reasonably
  well via `crossterm`; full parity is a stretch goal, not a v1 blocker).
- Cloud memory/graph sync, any oxagen.sh integration (see CUT list) — may
  return later as an optional plugin crate, never in the base binary.
- GUI/desktop app wrapper (Tauri, etc.) — CLI/TUI only.
- Server/daemon mode beyond what's needed for the code-graph live index
  (`ADR-016`'s daemon concept ports as an in-process background task or a
  short-lived local watcher, not a persistent network service).
