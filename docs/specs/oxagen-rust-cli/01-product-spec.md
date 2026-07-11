# Oxagen Rust CLI — Product Spec

## 1. Mission

Build the fastest, most token-efficient, most capable open-source terminal
agent — installable in one command, usable with any model provider's own keys
in any combination, with no account, no telemetry-by-default, and no server
dependency — and make it demonstrably **#1 on SWE-bench Verified by more than
3 percentage points** over the next-best publicly comparable agentic CLI at a
fixed, identical worker model (methodology in `04-benchmark-strategy.md`).

Three pillars, in priority order:

1. **A coding agent specialized for the GLM 5.2 suite.** Z.ai's GLM 5.2
   coding models are the default worker/triage/judge suite; prompt profiles,
   tool-call dialect handling, context budgets, and the benchmark tuning loop
   are optimized for them first (`07-model-matrix.md`). Frontier models from
   every other family (Claude Fable 5, GPT-5.5, Gemini 3, Grok 4) are
   first-class alternates, not afterthoughts — routing is role-based and any
   key combination works.
2. **A local-first context engine.** Embeddings and a knowledge graph live on
   the user's disk, in the base binary, grounding every turn in the user's
   code and accumulated knowledge — and they are extensible through the Open
   Context Protocol, an open standard other tools can adopt
   (`06-context-protocol.md`).
3. **A full generative terminal.** Text, code, images, SVG, and video are all
   generated client-side through the same BYOK provider layer, available both
   as commands and as agent tools (`08-multimodal.md`).

## 2. Non-negotiables (binding for every phase)

1. **No phone-home requirement.** `oxagen run` (the core one-shot/interactive
   coding loop) must complete a real task with zero network calls other than
   the ones the user's configured model provider requires. No license check,
   no update ping (opt-in only, see §7), no mandatory account.
2. **BYOK, multi-provider, any-combination, no gateway lock-in.** The binary
   talks directly to provider APIs. Users bring any combination of
   `ZAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` /
   `XAI_API_KEY` / AWS credentials (SigV4, standard chain) / GCP credentials
   (ADC) / `OPENROUTER_API_KEY` / a local Ollama or OpenAI-compatible base
   URL. Every key present widens capability; any single key yields a fully
   working agent; zero keys still yields a working agent against a local
   model endpoint. No Oxagen-operated routing layer sits between the user and
   their model calls.
3. **Open source, permissive license, no CLA-gated contributions trap.**
   Apache-2.0 (engine/tools) + MIT (CLI/protocol/SDK) dual license, DCO-based
   contribution (`git commit -s`), no copyright assignment. Public repo,
   public issue tracker, public roadmap. The OCP specification text is
   CC-BY-4.0 so competitors can implement it freely — adoption is the point.
4. **Single static binary, sub-100ms cold start to first prompt render, no
   runtime dependency (no Node, no Python, no Docker required for the base
   product).** `musl` static linking on Linux; universal or per-arch binaries
   on macOS; no dynamic OpenSSL dependency (use `rustls`). Embedding models
   are fetched on first use with checksum pinning, never bundled into the
   binary (§5, `06-context-protocol.md` §4).
5. **Feature-complete relative to what makes today's CLI good as a coding
   agent** — not relative to its platform-integration surface. See the parity
   matrix in §5.
6. **Privacy by default.** Telemetry, if present at all, is anonymous,
   aggregate, and **opt-in**. Code, prompts, file contents, file paths, and
   API keys are never transmitted to Oxagen infrastructure by the OSS binary,
   full stop. The context store (knowledge graph, embeddings, memory) never
   leaves the user's disk unless the user explicitly installs an external OCP
   provider that syncs it — and installing one requires an explicit,
   per-provider consent step that names what data flows out.
7. **#1 on SWE-bench Verified by >3pp**, reproducible by a third party from
   the public repo with only a model API key, against the current best
   publicly documented comparable result at the time of the claim. See
   `04-benchmark-strategy.md`.
8. **The context plane is local and always on.** Embeddings + knowledge graph
   (code graph, facts, episodic memory) work offline, out of the box, with no
   account and no server, backed by a single per-workspace on-disk store.
   Remote/optional context sources plug in via OCP; they are additive, never
   required.
9. **Extension by open protocol, not by fork.** Tools extend via MCP
   (client); context extends via OCP (host). Both protocols are versioned,
   documented, and conformance-tested. There is no proprietary plugin API.
10. **Every lesson in `09-lessons-learned.md` is a requirement.** Each entry
    maps a TypeScript-era failure or discovery to a binding Rust behavior;
    PRs that violate one must amend the registry first (with justification),
    not silently regress it.

## 3. Target users

- Individual developers who want a fast, scriptable, local-first coding agent
  and refuse to install Node/Python toolchains just to run a CLI.
- Developers standardizing on GLM 5.2 for cost/performance who want a
  first-class agent tuned for it rather than a Claude-first tool where GLM is
  a degraded afterthought — this is an underserved audience and the default
  configuration serves them with exactly one env var set.
- Teams that want to self-host / air-gap (BYOK to their own Bedrock/Vertex
  tenancy, or fully local via Ollama, no third-party SaaS in the loop).
- CI/CD pipelines that need a fast, deterministic, JSON-first agent CLI
  without a Node cold-start tax.
- OSS contributors who want to extend/embed the agent — `oxagen-core` and
  `oxagen-tools` must be usable as library crates, and OCP/MCP must be the
  extension surface so extensions survive internal refactors.
- Toolmakers who want a standard way to serve *context* (docs indexes,
  org wikis, issue trackers, telemetry) to any agent — the OCP audience.

## 4. Provider model (BYOK, no gateway)

| Provider | Auth | Notes |
|---|---|---|
| **Z.ai (default suite)** | `ZAI_API_KEY` | GLM 5.2 coding suite (worker/triage/judge defaults), embeddings API, CogView image, CogVideoX video. OpenAI-compatible chat surface plus Z.ai-native endpoints for media. Both the international (`api.z.ai`) and mainland (`open.bigmodel.cn`) base URLs supported via config. |
| Anthropic | `ANTHROPIC_API_KEY` | Direct Messages API, streaming, native tool-use, extended thinking. Claude Fable 5 / Opus / Sonnet / Haiku tiers. |
| OpenAI | `OPENAI_API_KEY` | Responses API (streaming, tool-use, reasoning effort). GPT-5.5 family, gpt-image image generation, Sora video (where the account has access). |
| Google Gemini (direct) | `GEMINI_API_KEY` (alias: `GOOGLE_API_KEY`) | Gemini API (`generativelanguage.googleapis.com`) — Gemini 3 tiers, Imagen image generation, Veo video. Distinct from the Vertex adapter below: no GCP project required, one env var. |
| xAI | `XAI_API_KEY` | OpenAI-compatible surface; Grok 4 tiers + Grok image generation. |
| AWS Bedrock | Standard AWS credential chain + region | `bedrock-runtime` `Converse`/`ConverseStream` — native Bedrock models **and Model Garden custom imports** by ARN. |
| Google Vertex AI | ADC + project/region | Vertex `generateContent`/streaming — Gemini-on-Vertex **and Vertex Model Garden** endpoints. For enterprises with GCP tenancy; casual Gemini use should use the direct Gemini adapter above. |
| OpenRouter | `OPENROUTER_API_KEY` | One key, any vendor's model — zero-setup on-ramp. |
| Ollama / local OpenAI-compatible | none, or `--base-url` | vLLM, LM Studio, llama.cpp `server` — fully offline capable. |
| Generic OpenAI-compatible | `--base-url` + optional bearer token | Escape hatch for any other vendor without a bespoke adapter. |

Selection: `oxagen config model set <provider>/<model-id>` persists a default;
`--model <provider>/<model-id>` overrides per-invocation; `oxagen models list`
enumerates the catalog per configured provider. The catalog is data-driven and
refreshed from provider `/models` endpoints — **no call site ever hard-codes a
slug**, and an unknown slug is a loud, immediate error naming the catalog
refresh command, never a silent fallback (`09-lessons-learned.md` L-M1/L-M2).
Role-based defaults (worker/triage/judge/embed/image/video) and the exact
GLM 5.2 default assignments live in `07-model-matrix.md`.

Credential resolution order: CLI flag → env var → provider-native config (AWS
profile / ADC file / `~/.config/oxagen/credentials.toml`) → interactive prompt
on first use (never silently fails with an opaque provider error).

No default model is billed through Oxagen. There is no `oxagen login`
anywhere.

## 5. Feature parity matrix — keep / rebuild / cut

Derived from the TS CLI's actual command inventory (`apps/cli/GAPS.md`,
`apps/cli/README.md`) and engine internals (`packages/agent-engine`,
`apps/cli/src/agent/**`, `apps/cli/src/runtime/**`).

### KEEP — the product

| Capability | TS source (reference) | Rust target |
|---|---|---|
| Step-driver agent loop (evaluate→enhance→route→execute→judge→revise) | `packages/agent-engine/src/pipeline/index.ts`, `loop-driver.ts` | `oxagen-core` |
| Tool set: read_file (line numbers), write_file, edit_file (fuzzy-match failure feedback, replace_all), bash (middle-out truncation, signal-aware, timeout backstop), grep/glob (ripgrep-backed) | `packages/agent-engine/src/tools.ts` | `oxagen-tools` |
| Code-graph context engine: tree-sitter parse, symbol/import-edge index, semantic search | `packages/code-graph/src/*`, `apps/cli/src/daemon/code-graph/*` | `oxagen-graph` (native tree-sitter, no WASM), served through the context plane |
| **Knowledge graph + embeddings (context plane)** | `packages/engram/*` concepts, cloud graph ADR-018 concepts — reconceived local-first | `oxagen-context` + `ocp-*` (`06-context-protocol.md`) |
| Model router (cost/tier-aware) + rate card | `apps/cli/src/agent/model-router.ts`, `rate-card.ts` | `oxagen-model` (`07-model-matrix.md`) |
| Multi-provider `AgentAi` port abstraction | `packages/agent-engine/src/ports.ts` | `oxagen-model::Provider` trait |
| Best-of-N candidate generation + selection (test signal + diff-judge) | `docs/specs/cli-swe-bench/02-spec.md` §5 | `oxagen-pipeline` |
| Evidence-based judge (diff + test-tail, judge≠worker) | same | `oxagen-pipeline` |
| Fleet / multi-agent orchestration: worktree isolation, planner DAG, commit ledger | `apps/cli/src/agent/fleet/*` | `oxagen-fleet` |
| Interactive REPL/TUI: streaming render, diff view, slash commands, HUD | `apps/cli/src/repl/*`, `apps/cli/src/tui/*` | `oxagen-tui` (ratatui) |
| **Media generation: image / SVG / video, as commands and agent tools** | `image.*`/`video.*`/`svg.*` commands (server-side in TS — mechanism replaced, user value kept) | `oxagen-media` (`08-multimodal.md`) |
| On-device/local model runtime (GGUF via llama.cpp bindings) | `apps/cli/src/runtime/providers/on-device*.ts` | `oxagen-model::local` (native FFI) |
| Memory (episodic recall/write, salience, promotion to rules) — local-only | `apps/cli/src/agent/memory.ts`, `packages/engram/*` (concepts) | `oxagen-context::memory`, embedded store, no ClickHouse |
| Workspace rules (`.oxagen/rules/`) — Tier-1 prompt injection + Tier-2 tool-gate guard | `apps/cli/src/rules/*` | `oxagen-core::rules` |
| Settings/hooks (Session/PreToolUse/PostToolUse) | `apps/cli/src/settings/*` | `oxagen-core::hooks` |
| Slash commands, skills (`.md`-defined) | `apps/cli/src/slash/*`, ADR-008 | `oxagen-cli::slash`, filesystem-first unchanged |
| MCP client (external MCP servers as tools) | `apps/cli/src/mcp/client.ts` | `oxagen-mcp` |
| PR/CI monitor (watch a PR to green) | `apps/cli/src/lib/pr-monitor.ts` | `oxagen-fleet::pr_monitor` |
| Init / project scaffolding | `apps/cli/src/project/init.ts` | `oxagen-cli::init` |
| Config file + env var resolution | `apps/cli/src/lib/config.ts` | `oxagen-cli::config` (TOML) |
| Trace/trajectory recording (JSONL, replay) | `apps/cli/src/agent/trace*.ts` | `oxagen-core::trace` |
| `--output-format text\|json\|stream-json` | `apps/cli/src/repl/one-shot.ts` | `oxagen-cli` (first-class) |

### CUT — platform-bound, no home in an account-free OSS product

Everything whose entire purpose is talking to oxagen.sh: `org.*`,
`workspace.*`, `billing.*`, `plugin.*` (marketplace/registry/credential
commands), `document.*`/`documents.*` (server-side doc generation + PDF),
`agent mcp register/list` (the *platform's* MCP registry — connecting to
external MCP servers stays), `agent task background *` (server-managed
background tasks), `conversation.*` (server-side chat history),
`automation.*`, `api-key.*` (platform API keys), `notifications.*`, `privacy
export/erase` (against Oxagen's data store — no Oxagen-held data exists),
`skill workspace list` (server-synced catalog — filesystem-first skills
stay), `user preferences *`, `system install instructions`, telemetry's
platform ingest route and its opt-out posture, graph-sync-to-web-app
(ADR-018), Vercel AI Gateway routing, `streamAgentReply`/metered billing
path, Neo4j-backed cloud code-graph.

> **Rev 2 note:** `image.*` / `video.*` / `svg.*` are **no longer cut**. Rev 1
> cut them because the TS implementation was a server round-trip to oxagen.sh.
> The *user value* — generating media from the terminal — has no platform
> dependency when rebuilt against BYOK provider APIs, so it moves to KEEP with
> a new mechanism (`oxagen-media`, `08-multimodal.md`).

### REBUILD DIFFERENTLY — same user value, different mechanism

| TS mechanism | Why it can't carry over as-is | Rust replacement |
|---|---|---|
| Vercel AI Gateway model routing | Gateway is an oxagen.sh-operated proxy | Direct per-provider adapters (`oxagen-model`), role-based router (`07-model-matrix.md`) |
| `AI_GATEWAY_API_KEY` credential resolution | Same | Provider-native credential chains per §4 |
| Login/OAuth+PKCE against oxagen.sh | No account to log into | No login command; config holds provider keys/model defaults only |
| Telemetry to `POST /v1/telemetry/usage` (opt-out) | No Oxagen ingest endpoint | Opt-in only, self-hostable ingest or removed for v1 (`03-plan.md` decision point) |
| Memory backed by `@oxagen/engram` (ClickHouse/DuckDB adapters) | Platform-coupled storage | Embedded single-file store in `oxagen-context` (`06-context-protocol.md` §4) |
| Code-graph sync to Neo4j (ADR-018 cloud graph) | Cloud-only | Local knowledge graph in the context plane; optional external graphs via OCP |
| Server-side `image.*`/`video.*`/`svg.*` generation | Server round-trip to oxagen.sh + Oxagen billing | Client-side `oxagen-media` calling Z.ai CogView/CogVideoX, OpenAI gpt-image/Sora, Gemini Imagen/Veo, xAI image APIs with the user's own keys (`08-multimodal.md`) |
| MCP server hosted by Oxagen | N/A to a standalone binary | MCP *client* only; context extensions via OCP *host* |

## 6. Success metrics (definition of done for "v1.0")

| Metric | Target | How verified |
|---|---|---|
| SWE-bench Verified resolve rate vs. best public comparable | **≥ +3.0 percentage points**, same pinned model | `bench/swe-bench` harness (`04-benchmark-strategy.md`) |
| SWE-bench Verified at pinned GLM 5.2 flagship | Best published GLM 5.2 scaffold result | Same harness — the "specialized for GLM 5.2" claim needs its own number |
| Cold start to first token | < 150ms process start, < 100ms pre-network | `hyperfine` / instrumented startup trace |
| Binary size (static, stripped) | < 40MB per platform target (embedding models excluded — fetched on first use) | CI artifact size check |
| Zero network calls with only a model key configured | 0 calls other than the model API (embedding-model first-fetch exempted, one documented CDN call, checksum-pinned) | Network-namespace-gated integration test |
| Context plane: cold index of a 5k-file repo | < 60s full index, < 150ms incremental re-index of one file save | Criterion benches on fixture repos |
| Context plane: hybrid retrieval latency (vector + graph expansion) | p95 < 100ms on a 100k-chunk index | Criterion bench |
| OCP conformance | Reference host + both reference providers pass the public conformance suite | `ocp-conformance` in CI |
| Media generation | Image + SVG + video each generate end-to-end via ≥2 distinct provider families | Recorded-fixture integration tests + one live smoke per release |
| Test coverage (workspace-wide) | ≥ 85% line coverage on `oxagen-core`/`oxagen-tools`/`oxagen-pipeline`/`oxagen-context`, ratchet toward 90 | `cargo llvm-cov` in CI |
| Golden-trajectory parity with the frozen TS spec (migration period only) | 100% event-stream parity on recorded inputs | CI conformance suite, retired post-port |
| License scan | 0 GPL/AGPL/SSPL transitive dependencies | `cargo deny` in CI |
| Distribution | `cargo install`, Homebrew, `curl \| sh`, GH Releases (4 OS/arch combos) all green | Release CI job |

## 7. Explicitly out of scope for v1.0

- Windows-native TUI parity (ratatui via `crossterm` works; full parity is a
  stretch goal, not a v1 blocker).
- Any oxagen.sh integration (see CUT) — may appear later only as external
  OCP/MCP providers, never in the base binary.
- GUI/desktop app wrapper (Tauri, etc.) — CLI/TUI only.
- Server/daemon mode beyond the in-process code-graph watcher.
- Audio generation/transcription (music, TTS, STT) — the `oxagen-media`
  architecture leaves room (`08-multimodal.md` §8), but it is a fast-follow,
  not v1.
- OCP *server-side* hosting features (multi-tenant context serving) — the
  binary is an OCP host (consumer) plus reference providers; running a
  context service for a team is someone else's product (possibly oxagen.sh's).
