# Oxagen Rust CLI — Build Plan (phased)

Branch/worktree per this repo's operating mode: cut `feat/oxagen-rust-cli`
from a fresh `main`, work in `git worktree add ../oxagen-rust-cli -b
feat/oxagen-rust-cli` (unambiguously a "large body of work" per CLAUDE.md),
commit+push frequently, open a draft PR immediately after the Cargo workspace
skeleton lands (Phase 0 exit).

Sub-issue this in Linear as one `epic` (`oxagen-v2` project) with one
sub-issue per phase (8 phases → 8 sub-issues, further split 3–6 ways within a
phase where needed). Assignee: Mac Anderson. Labels: `agents`, `tech-debt`,
plus `ci`/`infra` where the phase is mostly tooling.

> Rev 2 deltas vs. rev 1: Phase 0's provider spike now proves **Z.ai (GLM
> 5.2, the default suite)** alongside Anthropic; Phase 2 grows the xAI and
> Gemini-direct adapters; Phase 3 becomes the **context plane + OCP** phase;
> a new **Phase 5 (media)** exists; bench and OSS shift to Phases 6–7.
> `09-lessons-learned.md` items are tagged to their phase below as L-refs —
> each phase's exit includes "all L-refs assigned to this phase are
> implemented and tested."

## Phase 0 — Workspace skeleton + provider spike (prove the riskiest bets first)

**Goal:** a `cargo build` binary that streams one tool-calling turn against
**Z.ai (GLM 5.2)** and against Anthropic, with zero engine logic — pure
plumbing risk retirement.

1. Cargo workspace scaffold: all crates from `02-architecture.md` §2 as empty
   stubs with correct dependency edges (`ocp-types` and `oxagen-protocol`
   depend on nothing internal).
2. `oxagen-protocol` + `ocp-types`: core serde types with round-trip tests.
3. `oxagen-model` spike: Z.ai adapter (OpenAI-compatible chat + its tool-call
   dialect quirks, real `ZAI_API_KEY` smoke test) and Anthropic adapter
   (Messages API + SSE). This retires the two riskiest unknowns: GLM 5.2
   tool-call dialect fidelity (the default suite must work *first*, not
   last) and raw SSE parsing quality.
4. Catalog skeleton: seed `catalog/` data + `models refresh` against Z.ai and
   Anthropic `/models`; unknown-slug hard error in place from day one
   (L-M1, L-M2).
5. CI: `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `cargo deny`,
   `cargo audit` as a `crates/**`-scoped GitHub Actions job.
6. **Push the branch, open the draft PR now.**

Exit: `cargo run -p oxagen-cli -- --version`; both spikes stream a real
tool-calling response; CI green.

## Phase 1 — `oxagen-tools` (fs/exec/grep/glob/diff)

Unchanged from rev 1 in substance:

1. `read_file` (line numbers, ranges, size caps), `write_file`, `edit_file`
   (fuzzy-match failure diagnostics ported line-for-line from `tools.ts`,
   `replace_all`).
2. `exec`: process groups, timeout backstops, signal-based kill, middle-out
   truncation. Workspace-root pinning that `cd` cannot silently diverge
   (L-S2).
3. `grep`/`glob`: shell to `rg`/`fd` when present; pure-Rust fallback via
   `grep`+`ignore` crates.
4. `diff`: `git2` + synthetic untracked-file diffs.
5. Conformance tests mirroring the TS `tools.test.ts` corpus.

Exit: `cargo test -p oxagen-tools` green, ≥85% coverage; fixture-repo harness
proves fs/grep/exec incl. a Python fixture.

## Phase 2 — `oxagen-model` (full matrix) + `oxagen-core` step-driver

The score-critical phase.

1. Round out adapters: OpenAI (Responses), **Gemini direct**, **xAI**,
   Bedrock, Vertex, OpenRouter, generic OpenAI-compatible, local GGUF FFI.
   Dialect translation layer + per-family recorded-fixture conformance suite
   (`07-model-matrix.md` §4).
2. Role router: worker/triage/plan/judge/embed/vision/image/video roles,
   scenario defaults table (`07-model-matrix.md` §5), per-role config +
   slash commands, `Option<ModelRef>` auto mode (L-M3), circuit breakers +
   fallback events.
3. Credential chain per `01-product-spec.md` §4; unit tests per provider per
   source.
4. `oxagen-core` step-driver: one model call per step, message accumulation,
   `AgentEvent` emission at every boundary; retry+backoff with resume;
   compaction (token estimators validated per provider, stable system
   prefix for prompt caching, dedup of repeated identical tool outputs —
   L-E3); tool-output budget + eviction; loop detection; malformed-call
   repair tuned per dialect.
5. Rules engine + hooks engine ports.
6. Per-turn/session USD budget, three modes, normalized usage envelope
   (L-M5), `BudgetTick` events.
7. Property tests: compaction never drops a still-referenced tool result;
   budget eviction monotonic; retry never re-executes a completed
   non-idempotent tool call.

Exit: synthetic 200-step turn (scripted provider incl. 429s, stream drop,
context pressure) survives across **three dialects** (GLM 5.2, Anthropic,
OpenAI shapes); ≥85% coverage on `oxagen-core`.

## Phase 3 — Context plane: `oxagen-context` + `ocp-*` + `oxagen-graph`

1. `context.db` storage: SQLite schema (nodes/edges bi-temporal, sqlite-vec
   embeddings, episodes, fingerprints) + migration story.
2. Local embedder: ONNX runtime wrapper, first-use fetch with checksum pin,
   `EmbedderFingerprint` discipline, byte-compat re-embed skip (L-C2).
3. `oxagen-graph`: tree-sitter indexers (start with the TS-supported
   language set; fix the known thin Python import-edge resolution rather
   than porting it), incremental re-index via `notify`, warm-at-mount
   (L-C1).
4. `ocp-host`: stdio + streamable-http transports, handshake, capability
   negotiation, consent gating; built-ins (code graph, memory, git history)
   registered through the same interface as externals.
5. Retrieval pipeline: fusion, dedup, MMR, budget packing, provenance,
   `ContextRecall` events; p95 latency bench in CI (Criterion).
6. Write-back: episode summaries, fact upserts, supersession.
7. `ocp-conformance` v0 + `ocp-inspect`; one out-of-process example provider
   (`ocp-docs`) to prove the external path.

Exit: cold-index and retrieval latency targets met (`01-product-spec.md`
§6); an external stdio provider passes conformance and its frames show up
cited in a real turn; kill-signal during indexing leaves a consistent store
(L-L1 test).

## Phase 4 — `oxagen-pipeline` + `oxagen-mcp` + golden-trajectory harness

1. `oxagen-pipeline`: evaluate→enhance→route→execute→judge→revise; triage
   fast paths (simple-prompt classification skips planner+judge — L-E2);
   scope-review gate; evidence-based judge (judge≠worker, cross-family when
   available); best-of-N generation + selection.
2. `oxagen-mcp`: MCP client (stdio + streamable http), tool registration
   alongside native tools.
3. Golden-trajectory conformance harness: record TS-engine trajectories on
   fixed tasks, replay through the Rust stack, assert event-stream parity.

Exit: golden replay green on the fixture set; best-of-N beats single-shot on
a small sample; an external MCP server works end-to-end.

## Phase 5 — `oxagen-media` + `oxagen-fleet` + `oxagen-tui` + `oxagen-cli`

1. `oxagen-media`: image (Z.ai CogView + gpt-image + Imagen + xAI), SVG
   pipeline (generate→validate→sanitize→optimize→preview, repair loop —
   L-V2), video (async jobs, cost gate, resume — L-V3), terminal preview
   ladder, artifact manifest. Recorded-fixture tests; one live smoke per
   family.
2. `oxagen-fleet`: planner DAG, worktree isolation (isolate-by-default),
   commit ledger, PR/CI monitor with capped deferred waits (L-E4).
3. `oxagen-tui`: event-log REPL per ADR-023 concepts — streaming render,
   diff view + files-touched panel fed by `FileChange` events (L-T5), scope
   review card, fleet panels, HUD with live budget; mouse reporting off by
   default (L-T2), paste chips (L-T3), line-exact scroll clipping (L-T4);
   Ink-era test lessons applied as ratatui test-harness rules (poll not
   sleep; assert on backing buffer not ANSI strings).
4. `oxagen-cli`: `clap` tree — `run`, default-interactive, `gen`, `context`,
   `graph`, `ocp`, `mcp`, `models`, `config`, `init`, fleet verbs,
   `--output-format text|json|stream-json`, headless-capable throughout.
5. Distribution scaffolding: `cargo-dist`, Homebrew tap, `curl | sh`.

Exit: a person with only `ZAI_API_KEY` set installs via `curl | sh` and (a)
fixes a failing test in a real repo interactively and headlessly, (b)
generates an image, an SVG diagram, and (with confirmation) a video, (c) sees
context citations from their own codebase in the transcript. Same walkthrough
passes with only `ANTHROPIC_API_KEY`.

## Phase 6 — Bench proof (the #1-by->3pp claim)

Execution against `04-benchmark-strategy.md`, now two-track:

1. Harbor adapter for the native binary; smoke; ~20-instance sample; failure
   buckets; iterate.
2. **Track A (headline):** full Verified run vs. best comparable agent at
   the same pinned frontier model.
3. **Track B (specialization claim):** full Verified run at pinned GLM 5.2
   flagship vs. best published GLM-scaffold result; publish the number with
   the same fairness rules.
4. Best-of-N tuning on a held-out dev subset only; cross-family judging
   evaluated explicitly.
5. Publish methodology + raw trajectories.

Exit: reproducible, documented runs on both tracks; headline ≥ +3.0pp or the
kill/pivot criteria in `05-risk-register.md` fire.

## Phase 7 — Open-source release

1. `cargo deny`/`cargo audit`/license-header lint green; dependency license
   review.
2. OCP formalization: spec text (CC-BY-4.0) into `spec/`, TS + Python
   provider kits, conformance suite polished, `ocp-inspect` documented,
   seed providers (`ocp-docs`, `ocp-github`) published.
3. `git subtree split` into the public repo; public CI; docs site
   (README, CONTRIBUTING + DCO, security policy, architecture doc,
   OCP adoption guide).
4. Public issue tracker seeded with known-limitations from the risk
   register.
5. Announce with both benchmark tracks + the OCP launch (the protocol is
   the story for the ecosystem audience; the benchmark is the story for the
   user audience).
6. Delete `crates/` from the monorepo after one clean public release cycle.

Exit: public repo live and installable by a stranger; `cargo install
oxagen-cli` + `curl | sh` green from a clean machine; at least one
third-party-runnable OCP provider example documented end to end.

## Cross-cutting notes

- **Never run a full workspace `cargo test` as the iterating command** —
  `cargo nextest run -p <crate> <test>` while working; full suite in CI.
- **Every phase leaves the branch green and pushed**; commit at every
  meaningful sub-step.
- Phases 1–2 remain the score-critical path. Phase 3 (context) and Phase 4
  (pipeline/MCP) can partially parallelize once the Phase 2 trait surface is
  stable; within Phase 5, media/fleet/TUI are three parallelizable
  workstreams over the frozen event vocabulary.
- **Effort (Linear sizing):** P0: M (grew: two spikes + catalog). P1: M.
  P2: XL. P3: XL (grew: whole context plane + protocol). P4: L. P5: XL
  (three workstreams). P6: M–L (two tracks). P7: M.
