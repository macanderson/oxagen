# Oxagen Rust CLI — Build Plan (phased)

Branch/worktree per this repo's operating mode: cut `feat/oxagen-rust-cli`
from a fresh `main`, work in `git worktree add ../oxagen-rust-cli -b
feat/oxagen-rust-cli` (this is unambiguously a "large body of work" per
CLAUDE.md), commit+push frequently, open a draft PR immediately after the
Cargo workspace skeleton lands (Phase 0 exit). Each phase below is sized to
land as its own PR (or a small stack of PRs) against that feature branch, or
directly against `main` once the crate exists and is gated in CI — team's
call at Phase 0 exit based on how disruptive a long-lived branch feels.

Sub-issue this in Linear as one `epic` (`oxagen-v2` project) with one
sub-issue per phase (7 phases → 7 sub-issues, further split 3–6 ways within a
phase if a single dispatched subagent can't reasonably carry it). Assignee:
Mac Anderson. Labels: `agents`, `tech-debt`, plus `ci`/`infra` where the
phase is mostly tooling.

## Phase 0 — Workspace skeleton + provider spike (prove the riskiest bet first)

**Goal:** a `cargo build` that produces a binary that can stream one turn
against Anthropic and against Bedrock, with zero engine logic — pure plumbing
risk retirement before investing in the step-driver.

1. Cargo workspace scaffold: all 9 crates from `02-architecture.md` §2 as
   empty stubs with correct inter-crate dependency edges (`oxagen-cli` depends
   on everything; `oxagen-protocol` depends on nothing internal).
2. `oxagen-protocol`: `AgentEvent`, `ModelRunRequest`/`ModelStream`,
   `ToolCall`/`ToolOutput` — the types from `02-architecture.md` §3–4, with
   `serde` derives and unit tests for round-trip (de)serialization.
3. `oxagen-model` spike: Anthropic adapter (direct HTTP + SSE parse via
   `reqwest` + `eventsource-stream` or hand-rolled) and Bedrock adapter
   (`aws-sdk-bedrockruntime`, `ConverseStream`) — both implementing
   `Provider`, both proven against a real API key with a hardcoded "say
   hello and call a fake tool" smoke test. This retires the two biggest
   unknowns (raw SSE parsing quality vs. an official AWS SDK) before Phase 1
   commits to a design.
4. CI: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`,
   `cargo deny check`, `cargo audit` as a new GitHub Actions job
   (`.github/workflows/rust-cli.yml`), triggered only on `crates/**` changes
   (mirrors how `bench/web` is excluded from unrelated CI per existing
   conventions) — do not let this job block unrelated PRs.
5. **Push the branch, open the draft PR now**, per operating mode.

Exit: `cargo run -p oxagen-cli -- --version` works; both provider spikes
stream a real response in a manual smoke test (documented, not yet
automated E2E); CI job green on the skeleton.

## Phase 1 — `oxagen-tools` (fs/exec/grep/glob/diff)

Highest speed win, lowest logic risk, easiest to conformance-test against
the TS tool set's exact behavior (`packages/agent-engine/src/tools.ts`).

1. `read_file`: line-numbered output (`cat -n`-style), range support, size cap.
2. `write_file` / `edit_file`: exact-match edit with fuzzy-match failure
   diagnostics (closest-line search via Levenshtein — port
   `closestLine`/`similarity`/`occurrenceLines`/`describeEditFailure` from
   `tools.ts` line-for-line logic, `replace_all` option.
3. `exec`: `tokio::process::Command`, process-group creation (`nix::unistd::
   setsid` or `setpgid`), timeout backstop per the TS `toolBackstopMs` table,
   real signal-based kill on abort/timeout (closes the documented bash leak),
   middle-out (head+tail) output truncation.
4. `grep`/`glob`: shell to `rg`/`fd` when present on `$PATH` (fast path);
   pure-Rust fallback (`grep` + `ignore` crates, which already respect
   `.gitignore` — this is a Python-repo win vs. the TS JS-walker: no bespoke
   ignore-list needed, `ignore` crate handles it natively).
5. `diff`: `git2` (libgit2 bindings) for tracked-file diffs; synthetic
   `--no-index`-equivalent diff for untracked files (port the untracked-file
   fix from the TS `workspace.ts`).
6. Conformance tests: for every TS `tools.test.ts` / `tools.extra.test.ts`
   case, an equivalent Rust test asserting the same tool-call → same
   observable output shape (not byte-identical strings necessarily, but same
   semantic outcome: same error class, same truncation boundary behavior).

Exit: `oxagen-tools` usable standalone (`cargo test -p oxagen-tools` green,
≥85% coverage); a tiny hand-written harness proves fs/grep/exec against a
fixture repo including a Python fixture (validates the ignore-set win).

## Phase 2 — `oxagen-model` (full provider matrix) + `oxagen-core` step-driver

The score-critical phase — same reasoning as the TS Phase 1
(`docs/specs/cli-swe-bench/03-plan.md` Phase 1), now in Rust from the start
rather than retrofitted.

1. Round out `oxagen-model`: OpenAI, Vertex AI, OpenRouter, generic OpenAI-
   compatible (covers Ollama/vLLM/LM Studio in one adapter), local GGUF via
   `llama-cpp-2` bindings (native, replacing the TS `node-llama-cpp` bridge —
   should be strictly faster to first token, no N-API marshaling overhead).
2. Credential resolution chain per §4 of `01-product-spec.md`: env → CLI flag
   → AWS default credential chain / GCP ADC → `credentials.toml` →
   interactive prompt. Unit tests per provider per resolution source.
3. `oxagen-core` step-driver: one model call per step, explicit message
   accumulation, `AgentEvent` emission at every step boundary. This is the
   direct Rust port of the TS Phase-1 step-driver design — build it *as* a
   step-driver from day one (the TS version had to retrofit this onto a
   monolithic `streamText` call; Rust has no such legacy to work around).
4. Retry+backoff (jittered exponential, retryable-error classification per
   provider — 429/5xx/transport vs. 4xx-terminal), resumes from last
   completed step.
5. Compaction: token estimator (tiktoken-compatible via `tiktoken-rs` for
   OpenAI-family, provider-specific estimators elsewhere), ~80%-of-window
   trigger, summarize-old-keep-recent strategy, stable system-prefix
   preserved for prompt caching.
6. Global tool-output budget + eviction (oldest-bulky-first, one-line stub
   replacement), loop detection (N identical failing calls → nudge, M →
   structured failure), malformed tool-call repair.
7. Rules engine (`.oxagen/rules/` Tier-1 prompt injection + Tier-2 tool-gate
   guard) and hooks engine (Session/PreToolUse/PostToolUse) — ported
   directly from `apps/cli/src/rules/*` and `apps/cli/src/settings/*`
   semantics.
8. Local memory: `rusqlite`-backed episodic store, salience scoring, rule-
   promotion candidate surfacing — same concepts as `apps/cli/src/agent/
   memory.ts` / `packages/engram`, new storage (no ClickHouse/DuckDB-adapter
   dependency; SQLite is the whole point of "no server").
9. Property tests: compaction never drops a still-referenced tool result;
   budget eviction is monotonic; retry never re-executes a non-idempotent
   tool call that already completed (state-machine test).

Exit: a synthetic 200-step turn (mocked `Provider` returning scripted
responses incl. injected 429s, a stream drop, and simulated context
pressure) survives end-to-end, matching the TS Phase-1 exit bar
(`docs/specs/cli-swe-bench/03-plan.md` Phase 1 exit) but native from the
start; `cargo llvm-cov` ≥85% on `oxagen-core`.

## Phase 3 — `oxagen-graph` + `oxagen-pipeline` + `oxagen-mcp`

1. `oxagen-graph`: native tree-sitter parsers per language (start with the
   set the TS code-graph already supports; prioritize fixing the TS gap
   where Python import-edge resolution is thin — this is a chance to do
   Python right from the start, not a port of a known limitation), local
   embedding (candle-based small model or ONNX Runtime) + vector index
   (`hnsw_rs` or `usearch`), persisted per-workspace SQLite/DuckDB.
2. `oxagen-pipeline`: evaluate→enhance→route→execute→judge→revise
   orchestration over `oxagen-core::Engine`; evidence-based judge (diff +
   test-tail, judge≠worker enforced via a distinct `Provider` instance);
   best-of-N (`--candidates N`) generation + selection (test-outcome +
   diff-judge-panel).
3. `oxagen-mcp`: MCP client — stdio + streamable-http transports, tool
   discovery, registration into `oxagen-core`'s tool registry alongside the
   native tool set.
4. Golden-trajectory conformance harness: record TS-engine trajectories on
   the same fixed tasks (small deterministic fixture set + a handful of real
   SWE-bench instances with recorded model responses for determinism), replay
   through the Rust stack, assert event-stream parity per
   `docs/specs/cli-swe-bench/04-rust-port.md`'s existing conformance design.
   This is the point where the "port the spec, not the code" strategy pays
   off — the TS engine's tests become this suite's oracle.

Exit: golden-trajectory replay green in CI on the fixed fixture set; a real
best-of-N run on a small sample beats single-shot; `oxagen-mcp` connects to
at least one real external MCP server (e.g. a filesystem or GitHub MCP
server) end to end.

## Phase 4 — `oxagen-fleet` + `oxagen-tui` + `oxagen-cli`

1. `oxagen-fleet`: planner DAG, git-worktree isolation (isolate-by-default —
   fixing the TS default-unsafe-concurrency finding from `01-gap-audit.md`
   directly, not carrying the bug forward), commit ledger (SQLite), PR/CI
   monitor (shells to `gh` CLI first for simplicity, `octocrab` if a native
   GitHub client proves worth the dependency weight).
2. `oxagen-tui`: ratatui interactive REPL — streaming render, diff view,
   slash-command menu, HUD (rendered from day one, not built-then-orphaned
   as happened in TS per the gap audit), mouse selection. Maps onto
   `AgentEvent` — never touches `oxagen-core` internals directly.
3. `oxagen-cli`: `clap` command tree — `run` (one-shot), no-subcommand
   (interactive TUI, matches today's default-to-interactive UX),
   `agents`/fleet entrypoint (headless-capable from day one — fixes the TS
   TTY-lock P0 finding), `init`, `config`, `models list/set`, `--output-
   format text|json|stream-json`, `--max-steps`, credential setup wizard.
4. Distribution scaffolding: `cargo-dist` config for GH Releases across
   macOS (x86_64/arm64), Linux (x86_64/arm64, musl static), Windows
   (x86_64); Homebrew tap formula; `curl | sh` installer script.

Exit: a person with only `ANTHROPIC_API_KEY` set can `curl | sh` install and
run `oxagen run "fix the failing test in this repo"` against a real small
repo, interactively and headlessly, with `--output-format json` producing a
clean result envelope; fleet runs headless in CI.

## Phase 5 — Bench proof (the #1-by->3pp claim)

Full methodology lives in `04-benchmark-strategy.md`; this phase is the
execution against it.

1. Adapt `bench/swe-bench`'s Harbor adapter to install/run the Rust binary
   instead of (or alongside) the TS bundle — the adapter interface (install/
   run/patch-capture) is harness-side already generic per its own README;
   confirm and adjust `oxagen_terminal_bench.oxagen_agent` for a native
   binary instead of a Node bundle path.
2. Smoke: 1 instance end-to-end, non-empty patch, cost line parsed.
3. Small mixed sample (~20 instances); baseline resolve rate + failure
   buckets from trajectories (same iterate-on-failure-buckets discipline as
   the existing TS plan's Phase 4).
4. Full SWE-bench Verified run, oxagen-cli vs. the current best publicly
   documented comparable agent, same pinned model, via `compare.sh`-
   equivalent tooling (already exists in `bench/swe-bench`, needs the
   Rust-agent wiring from step 1).
5. Best-of-N tuning pass — this is the primary lever expected to deliver the
   >3pp margin, per `01-product-spec.md` §1 and the existing TS spec's own
   framing (`docs/specs/cli-swe-bench/02-spec.md` §5).
6. Publish methodology + raw results (`bench/web` dashboard already has the
   schema/plumbing — `oxagen.eval.v1`) with every fairness caveat from the
   existing `bench/swe-bench/README.md` "Fairness & methodology" section
   carried forward verbatim into the Rust project's own docs.

Exit: a reproducible, documented run showing resolve rate ≥ +3.0pp over the
comparison target at a fixed model, with raw trajectories published for
third-party audit. If the target is missed, this phase does not "ship
anyway" — see `05-risk-register.md` for the kill/pivot criteria.

## Phase 6 — Open-source the repo

1. `cargo deny`/`cargo audit`/license-header lint fully green; every
   dependency's license reviewed against Apache-2.0/MIT compatibility.
2. `git subtree split` `crates/oxagen-cli/` history into a new public
   `oxagen-cli` GitHub repo (preserves commit history, per `02-architecture.md`
   §7). Set up its own CI (mirrors the internal job, now public-facing).
3. Public docs site (README, CONTRIBUTING with DCO instructions, security
   policy, architecture doc adapted from `02-architecture.md`).
4. Public issue tracker seeded with the known-gaps/risk items from
   `05-risk-register.md` that are acceptable to ship with (labeled
   `known-limitation`), not hidden.
5. Announce with the benchmark results from Phase 5, methodology and raw
   data linked, comparison framing identical to the existing
   `bench/swe-bench` fairness rules (never present a number without its
   methodology attached).
6. Delete `crates/oxagen-cli/` from this monorepo once the public repo's CI
   and release pipeline are proven for one full release cycle — do not
   maintain two copies.

Exit: public repo live, installable by a stranger with no access to this
monorepo, `cargo install oxagen-cli` and `curl | sh` both work from a clean
machine, benchmark claim published with full methodology.

## Cross-cutting notes

- **Never run a full workspace `cargo test` as a substitute for the
  narrowest proving command** — same spirit as this repo's "never run all
  tests" rule for the TS workspace; use `cargo test -p <crate>` or `cargo
  nextest run -p <crate> <test-name>` while iterating, full workspace test
  only in CI / pre-merge.
- **Every phase leaves the branch green and pushed.** Commit at every
  meaningful sub-step (per crate, per trait impl, per test file), not just
  at phase boundaries.
- **Phases 1–2 are the score-critical path** (mirrors the TS plan's own
  framing) — deepest review, most tests, no shortcuts. Phases 3–4 can
  partially parallelize across subagents once the Phase 2 trait surface is
  stable (dispatch `oxagen-graph` and `oxagen-mcp` in parallel; they don't
  share files). Phase 5 cannot start meaningfully before Phase 2's exit bar
  (compaction/retry) — earlier bench numbers are noise from avoidable
  harness failures, exactly as the existing TS plan notes.
- **Effort estimate (rough, for Linear sizing):** Phase 0: S. Phase 1: M.
  Phase 2: XL (the score-critical crux, budget the most review here).
  Phase 3: L. Phase 4: L. Phase 5: M (mostly compute time + iteration, not
  code volume). Phase 6: S.
