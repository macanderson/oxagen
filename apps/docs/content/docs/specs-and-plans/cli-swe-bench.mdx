---
title: "CLI SWE-bench Harness"
description: "Archived spec & plan — status: shipped (audited 2026-07-03)."
---

> **Status: Shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The CLI SWE-bench Harness spec has been fully shipped across all 4 phases. Phase 0 (unblock bench) and Phase 1 (core-loop hardening) landed in PR #424 with step-driver, compaction, retry, and headless profile. Phase 2 (engine unification) removed ~5.4k LOC dead code and unified one-shot/fleet through a single engine. Phase 3 (verification) delivered best-of-N, evidence-based judge, PR monitor, commit ledger, and fleet safety. Bench infrastructure is operational on main with SWE-bench harness, prewarm overlay, and Harbor integration.

**Implementation evidence**

- packages/agent-engine/src/engine.ts — explicit step-driver with per-step model calls, retry+compaction boundary, tool-output budget
- packages/agent-engine/src/loop-driver.ts — loop detection and retry logic for transient errors
- apps/cli/src/lib/session.ts — OXAGEN_ALLOW_NO_SESSION synthetic benchmark session
- apps/cli/src/agent/adapters/gateway-agent-ai.ts — createGatewayAgentAi gateway-direct model access
- apps/cli/src/program.tsx — --output-format text|json|stream-json, --max-steps flags with result envelope
- packages/agent-engine/src/prompt/system-prompt.ts — headless vs interactive prompt profiles
- apps/cli/src/agent/best-of-n.ts — best-of-N orchestration with isolated worktrees and cross-candidate verification
- packages/agent-engine/src/evaluate/select.ts — evidence-based selector using git diff and test output
- apps/cli/src/lib/pr-monitor.ts — PR CI monitor with watch→fix→merge workflow
- apps/cli/src/lib/commit-ledger.ts — append-only ledger for work recovery
- apps/cli/src/rules/promote.ts — memory-to-rule promotion with salience thresholds
- apps/cli/src/agent/fleet/ — fleet safety with worktree isolation and orchestration
- bench/swe-bench/ — operational SWE-bench harness with prewarm overlay and Harbor integration
- PR #424 (main): step-driver, compaction, retry, headless profile shipped

**Source documents** (archived verbatim below)

- `docs/specs/cli-swe-bench/01-gap-audit.md`
- `docs/specs/cli-swe-bench/02-spec.md`
- `docs/specs/cli-swe-bench/03-plan.md`
- `docs/specs/cli-swe-bench/04-rust-port.md`

## Document — `01-gap-audit.md`

## Oxagen CLI — Gap Audit (2026-07-02)

Six parallel audits (architecture, core loop, REPL/TUI, command surface, pipeline/bench readiness, dead code) over `apps/cli` (~52k LOC) + `packages/agent-engine`, with the highest-stakes claims re-verified by direct file reads. Items marked **✅ FIXED** landed on `feat/cli-swe-bench-hardening` on 2026-07-02.

### How the CLI actually executes (ground truth)

- **Primary loop**: `@oxagen/agent-engine` `runTurn` (`packages/agent-engine/src/pipeline/index.ts`) — evaluate → enhance → route → execute (`runCodingAgent`) → judge → revise. Drives the REPL and plain one-shot. Port-based (AgentAi/Workspace/Memory/CodeGraph/Trace), fully headless-capable.
- **Legacy loop**: `apps/cli/src/agent/loop.ts` `runAgent` — direct `streamText`; drives only `--agent` one-shot and the fleet. Duplicates tools/router/prompt/helpers, and diverges (rules guards, hooks, MCP tools, per-tool timeouts wired here but NOT on the engine path).
- **Dead island**: `apps/cli/src/{orchestrator,pipeline,monitors,contracts}` (~4,045 LOC) — pre-migration brain, superseded by agent-engine (PR #267), zero live importers.
- **Bench harness already exists**: `bench/swe-bench` + `bench/terminal-bench` (Harbor, SWE-bench Verified default, compare.sh, ClickHouse dashboard) — was blocked by two CLI-side P0s (below, both fixed).

### P0 — bench blockers

| # | Finding | Evidence | Status |
|---|---|---|---|
| 1 | `OXAGEN_ALLOW_NO_SESSION=1` documented + set by run.sh but implemented nowhere → every trial `exit(1)` at `requireSession()` | `lib/session.ts:37`, `packages/config/src/registry.ts:1425` | ✅ FIXED — synthetic bench session |
| 2 | Headless model calls hardwired to platform `/v1/agent/llm`; synthetic token can't auth; `AI_GATEWAY_API_KEY` forwarded but unused | `agent/adapters/platform-agent-ai.ts:32`, `repl/one-shot.ts:80` | ✅ FIXED — `createGatewayAgentAi` (gateway-direct, per-vendor reasoning options) auto-selected for synthetic sessions |
| 3 | Stall/inactivity guards killed healthy long tool runs: engine emitted tool events only at step end, so one-shot's 300s guard aborted >300s test runs; legacy loop's 120s stall killed ANY bash >120s | `engine.ts:99` (old), `one-shot.ts:109`, `loop.ts:352` | ✅ FIXED — tool lifecycle events stream from fullStream parts; guards defer while tools are in flight; every engine tool has a timeout backstop |
| 4 | No transcript compaction anywhere + context-overflow uncaught and unrecoverable (400 falls through `normalizeAgentError`; REPL re-sends same too-large history until `/clear`) | `engine.ts:193`, `loop.ts:183`, grep-clean for compaction | OPEN — Phase 1 centerpiece |
| 5 | No retry on the worker stream: `createMeteredAi` retries only `generateObject` (evaluator/judge); a transient 429/5xx/network blip mid-stream kills the whole turn. One-shot didn't even have the metered wrapper | `metered-ai.ts:59`, `one-shot.ts:80` | PARTIAL — one-shot now wrapped (✅); stream retry needs the Phase-1 step-driver |
| 6 | One-shot had no machine-readable output and no step cap exposure | `program.tsx:58-82` | ✅ FIXED — `--output-format text\|json\|stream-json` + `--max-steps`; result envelope (text/steps/usage/model/filesTouched/complete/traceId) |
| 7 | Memory recall cross-contaminates bench instances (SWE-bench reuses repos; "recalled context" leaks between trials) | `engine.ts:59`, `one-shot.ts:72` | ✅ FIXED — `OXAGEN_DISABLE_MEMORY=1`, defaulted in the bench adapter unless warm-memory mode |
| 8 | Patch emission missed untracked files (`git diff HEAD` only) — a fix creating a new file scores as incomplete | `adapters/workspace.ts:171` | ✅ FIXED — synthetic `--no-index` diffs for untracked files (1MiB cap) |
| 9 | No top-level error net: unhandled rejections print raw Node traces (`oxagen code diff missing.txt`) | `index.tsx:51`, `commands/code.ts` | ✅ FIXED — unhandledRejection/uncaughtException handlers + main().catch |

### Core-loop correctness (engine + legacy)

- **[P1] Bash process-group leak on abort** — `runShellCommandBuffered` accepts no AbortSignal; on turn abort/tool timeout the detached subprocess runs to its own timeout (≤600s). Accumulates across a 500-instance bench run. `shell-runner.ts:162`. (Timeout backstop now resolves the *caller*; the process itself still needs signal threading.)
- **[P1] No tool-call repair / loop detection** — no `experimental_repairToolCall`, nothing detects the model repeating an identical failing call; only backstop is `stepCountIs(256)`. `loop.ts:292`, `engine.ts:94`.
- **[P1] No global tool-output budget** — 30k-char per-call clip only; 50 reads or a chatty test log fills the window (mechanism behind P0 #4). `agent-engine/src/tools.ts:13`.
- **[P1] Tool-output truncation keeps the HEAD, drops the TAIL** — pytest failure summaries live at the tail. `clip()` in both tool sets.
- **[P1] System prompt lacks verification discipline** — no repro→fix→test→regression protocol; interactive prompt is narration-heavy (token tax + wrong behavior for bench); engine `DEFAULT_SYSTEM` is one sentence. `agent/system-prompt.ts`, `engine.ts:5`.
- **[P1] Engine path drops rules guards, settings hooks, MCP tools** — wired only in the legacy loop; a `.oxagen/rules` guard or PreToolUse hook is inert in the REPL/one-shot users actually run. `loop.ts:205-281` vs `engine.ts:52`.
- **[P2] edit_file exact-match only, no line numbers in read_file** — model must reproduce exact bytes; failures burn steps with minimal feedback ("String not found"). Both tool sets.
- **[P2] grep/glob are in-process JS walks** — no ripgrep, no .gitignore, ignore-list is JS-ecosystem-only (no `.venv`, `__pycache__`, `.tox`, `*.egg-info`) — slow and noisy exactly on SWE-bench Python repos. `adapters/workspace.ts:24,119-160`.
- **[P2] Code graph half-blind on Python** — symbols parse (tree-sitter) but import-edge resolution only handles JS extensions (`RESOLVE_EXTENSIONS`), so `dependents`/`imports` are empty on Python repos while the prompt says "graph before grep". `daemon/code-graph/builder.ts:273`. Local graph has no embeddings (server Neo4j only).
- **[P2] On-device runtime**: real (node-llama-cpp GGUF bridge) but REPL-only (`/coordinator local`), unmetered, all 20 `sha256` pins empty (checksum verification is a no-op), downloads don't resume (18–32GB from zero on any error), `doStream` awaits full generation before emitting (no liveness). `runtime/provisioning/download.ts:217`, `runtime/models.json`.
- **[P3] `git diff` silently returns "" on failure** incl. 50MB maxBuffer overflow — an oversized diff scores as "no change". `adapters/workspace.ts:171`.
- **[P3] Inconsistent default model** — engine hard-defaults `claude-opus-4-8`, catalog default is Sonnet. `engine.ts:89` vs `model-catalog.ts:55`.

### Fleet / multi-agent (the "outperform" lever, currently unsafe)

- **[P1] Default is shared-tree concurrency with vacuous locks** — `--isolate` defaults false; ad-hoc tasks carry `files: []` so `task.files.some(...)` never serializes anything: N agents write one tree. `program.tsx:179`, `fleet/orchestrator.ts:133,231`.
- **[P1] `--isolate` integration branch is never merged back or surfaced** — a bench harness can't collect the patch; Ctrl-C force-removes worktrees before agents drain (work lost). `tui/fleet-view/index.tsx:86`, `fleet/orchestrator.ts:288`.
- **[P1] Fleet runs the bare legacy loop** — no evaluate/enhance/judge for subagents; also BYOK-gateway direct, bypassing the login gate the main path enforces (inconsistent policy, tracked as ADR-019 task B4).
- **[P0][commands] Fleet is TTY-locked** — `oxagen agents` renders Ink unconditionally (`useInput` requires raw mode): the flagship multi-agent feature cannot run in CI/headless at all. `tui/fleet-view/index.tsx:77`.
- Dependent tasks spawn from a frozen base ref (`git-isolation.ts:218`); unchecked `worktree remove`/`merge --abort` exit codes.

### Command surface

Positive: all 21 command files are real implementations — zero stubs/TODO/mock markers; all registered; login has a clean headless path (`--token`, env vars).

- **[P0] No headless fleet mode** (above). **[P0→✅] one-shot output/steps flags** (fixed).
- **[P1] Zero tests on 6 command files + shared transport** (`code`, `config`, `env`, `graph.search`, `graph.status`, `secret`, `lib/api.ts`, `lib/resolve.ts`) — `secret.ts` handles live credentials untested.
- **[P1] `daemon start` broken for published npm installs** — spawns `process.execPath --import tsx <path>.ts`; `tsx` is devDependency-only and dist ships no `.ts`. `daemon/lifecycle.ts:60`.
- **[P1] `daemon stop`/`status` never set a failure exit code.** `daemon/lifecycle.ts:98,133`.
- **[P2]** duplicated helpers (maskToken ×2, splitCsv ×2, org/workspace guard ×4, git plumbing ×2, scaffold regex ×3); two different "not logged in" messages; `-l` flag collision (labels vs limit); `graph search` JSON-only with no flag; six phrasings of `--json` help text; console.log vs process.stdout.write split.

### REPL / TUI

Verified solid: panel-dupe fix complete and dupe-safe; FIFO pump generation-guarding; process-group kill; focus model; async-memory unmount guard.

- **[P1] Per-token full-transcript re-render, un-memoized, + double measureElement per render** — every streamed token re-renders 40–100 components. Coalesce on ~30–60ms timer + `React.memo(MessageView)`. `interactive.tsx:1473,1669`.
- **[P1] `/hud` is a no-op** (toggles state; `<HudPanel>` never rendered) and **ThinkingIndicator is built+tested+never mounted** — during a turn the only signal is a prompt-bar glyph. `interactive.tsx:1054`, `components.tsx:662`.
- **[P1] `/effort` works but is missing from catalog + HELP** (undiscoverable); slash dispatch/HELP/catalog are three independent hardcoded lists with no parity test. `slash/catalog.ts:38`.
- **[P2]** idle Ctrl-C exits immediately (input-abandon footgun); no cursor movement/sent-history/paste handling in the prompt input; transcript + `historyRef` grow unbounded (memory + context); `oxagen view` renders 100% fabricated telemetry labelled "live" with dead hotkey hints; HELP omits 7 shipped commands; copy-pasted spinner/elapsed/statusStyle helpers ×3-4 files.
- **[P3]** argless built-ins matched with `===` (`/help x` → Unknown command); `$` injection in slash `applyArgs`; prefix-only slash menu; catalog never rebuilds mid-session; fleet 10Hz render timer never idles; stale `<Static>` comment.

### Dead code & bloat (10.4% of the CLI is certain-dead)

| Path | LOC | Why |
|---|---|---|
| `src/pipeline/**` | 2,075 | pre-migration original of engine runTurn |
| `src/orchestrator/**` | 889 | coordinator/router island, zero importers |
| `src/tui/welcome-screen/**` | 568 (+337 README) | `launchWelcomeScreen` has no caller |
| `src/monitors/**` (5/6 files) | 562 | reachable only via dead island |
| `src/contracts/**` | 519 | orphaned typed contracts (engine has its own types) |
| `src/agent/tasks/store.ts` | 226 | duplicate of task-registry, never wired |
| `src/repl/hud.tsx` | 163 | see `/hud` no-op |
| `src/lib/differential-context.ts` | 121 | all exports unused |
| `src/lib/structured-tool-io.ts` | 119 | all exports unused (its record-handle pattern is the right shape for the tool-output budget — harvest, then delete) |
| `src/daemon/code-graph/watcher.ts` | 102 | never imported |
| `src/repl/double-press.ts` | 47 | reimplemented inline |
| **Total certain-dead** | **≈5,391** | + ~300 LOC embedded (ThinkingIndicator, CatMouseChase, memory-client citation subsystem, `loadSession`) |

Also: `createTurnRunner` + `callModelWithTimeout`'s turn-runner half are test-only; cloud `ModelProvider` half of `runtime/providers` dead; `@inkjs/ui` dependency unused; `vitest.config.ts` coverage excludes ALL `.tsx` (21% of source — the exact blind spot that hid the unmounted components); 3 unjustified eslint-disables; `orchestrator.ts` filename collision (dead vs fleet).

Hygiene is otherwise excellent: 0 real `any`, 0 mock-in-prod, 0 NotImplemented, 1 real TODO (`project/init.ts:78`), all 33 "commented-out blocks" are rationale prose.

### Plan-vs-reality for the 8-group pipeline plan (`~/Desktop/outputs/oxagen-cli-pipeline`)

1 on-device: DONE (headless unreachable). 2 orchestrator/routing: PARTIAL (engine router live; coordinator-dispatches-workers thesis unbuilt; island dead). 3 context graph: DONE-core (engine enhance; Python edges missing). 4 assist tools: PARTIAL (enhancer+judge live; survey dead-island only). 5 monitors: BUILT-BUT-DEAD. 6 pipeline/verification: PARTIAL (5-step machine IS runTurn; verifyWork evidence gate + plan tool dead-island only; judge advisory, 1 revise round). 7 contracts: ORPHANED. 8 bug fixes: DONE (with the stream-consumption gap now fixed on this branch).

## Spec — `02-spec.md`

## Oxagen CLI — Target Spec: beat Claude Code on SWE-bench (and everything else)

### 1. Mission & success criteria

Primary: **oxagen ≥ Claude Code on SWE-bench Verified with the same worker model**, measured with the in-repo Harbor harness (`bench/swe-bench`) against the official 500-instance set.

| Metric | Target |
|---|---|
| SWE-bench Verified resolve rate | ≥ Claude Code baseline (same model), then beat it via best-of-N selection |
| Harness failure rate (non-model errors: crashes, timeouts, empty patches) | \< 1% of instances |
| Wall-clock per instance | ≤ Claude Code's, at parity settings |
| Tokens + $ per resolved instance | measured on every run; regression-gated |
| Long-trajectory stability | 200-step synthetic turn survives injected 429s/stream drops/context pressure |

Secondary: the same engine powers a best-in-class interactive CLI (single code path — no bench-only forks).

### 2. Architecture: one engine, ports, no duplicates

- `@oxagen/agent-engine` is **the only loop**. `--agent` one-shot and the fleet route through `runTurn`/`runCodingAgent`; `apps/cli/src/agent/loop.ts` + duplicated tools/router/prompt/planner are deleted.
- Delete the dead island (`orchestrator/`, `pipeline/`, `monitors/`, `contracts/` in apps/cli, ~4k LOC) after harvesting: **verifyWork evidence gate**, **plan tool**, **survey tool**, **monitors** concepts move into the engine pipeline.
- Engine gains injection seams the legacy loop had and the live path silently dropped: workspace rules (Tier-1 prompt + Tier-2 guard denies), settings hooks (Session/PreToolUse/PostToolUse), MCP tools, per-tool timeout policy.
- `shell-runner` moves out of `repl/` (dependency inversion) into `lib/exec`; AbortSignal threads from turn → tool → process group so an aborted turn kills its bash subtree.
- All ports stay JSON-serializable — this is the Rust seam (see 04-rust-port.md).

### 3. Core loop: the explicit step-driver

Replace the single monolithic `streamText(stopWhen: stepCountIs(256))` call with an engine-owned step loop (one model call per step, messages accumulated explicitly). This single change unlocks, at step boundaries:

1. **Retry with backoff+jitter** on 429/5xx/network/stream errors — resume from the last completed step instead of losing the turn. Retry budget per turn; abort respected instantly.
2. **Compaction**: token accounting per step (usage + estimator). At ~80% of the model's context window: summarize old tool results (keep the last N steps verbatim + a structured summary of earlier work: files read/edited, key findings, test status), preserving the stable system-prefix for prompt caching. On a provider `context_length_exceeded` despite that: hard-trim + one retry, never wedge.
3. **Global tool-output budget**: cumulative cap with eviction of oldest bulky results (replaced by one-line stubs: "output evicted — re-run if needed").
4. **Loop detection**: N identical failing tool calls → inject a corrective nudge; M repeats → stop with a structured failure.
5. **Malformed-call repair** (`experimental_repairToolCall` or equivalent) instead of relying on SDK defaults.
6. **Per-step trajectory JSONL** (see §8) and checkpoint/resume.

Timeout policy (landed on this branch, keep): no wall-clock turn cap; progress-based guards that treat in-flight tools as progress; every tool carries a timeout backstop; bash honors its declared `timeout_ms` (≤600s) + grace.

### 4. Tools: precision + speed on foreign repos

- **read_file**: `cat -n` line numbers; default line cap with explicit range indication.
- **edit_file**: structured failure feedback (closest fuzzy match with line numbers, whitespace-normalized hint, occurrence list), `replace_all` option, optional multi-edit. Failure messages teach the retry.
- **bash**: middle-out truncation (keep head + tail — failure summaries live at the tail); exit code always included; signal-aware.
- **grep/glob**: shell to `rg` when present (respects .gitignore natively; JS walker fallback); Python-aware ignore set (`.venv`, `__pycache__`, `.tox`, `.mypy_cache`, `.pytest_cache`, `*.egg-info`, `.eggs`).
- **code_graph**: Python import-edge resolution in the daemon builder; when graph coverage for the repo's language is thin, the system prompt automatically demotes graph-first guidance (honest capability signaling).
- **Patch capture**: untracked files included (landed); surface capture failures instead of silent `""`; raise/stream past 50MB.

### 5. Verification: evidence, not self-report

- **Evidence-based judge**: judge input = the actual `git diff` + executed commands with tail output (esp. test runs) — not the agent's prose. Verdict requires evidence categories (tests-run? repro-shown? regressions-checked?).
- **verifyWork gate** (harvested from the dead island): when on, a turn is not "complete" until evidence exists; judge findings drive bounded revise rounds (configurable > 1 for bench).
- **Multi-provider judge panels**: worker on Anthropic ⇒ judge on OpenAI/Google top models (already the single-judge default; extend to an optional N-judge panel with majority/veto for high-stakes runs and best-of-N selection). Judge ≠ worker enforced (exists).
- **System-prompt protocol** (both engine profiles): reproduce → write/keep a failing test → fix → re-run targeted tests → check regressions → final diff review. Two prompt profiles: `interactive` (narration) and `headless` (no narration tax; verification-first).
- **Best-of-N (the beat-Claude-Code lever)**: bench runner `--candidates N` — N independent trajectories (temperature/seed/model-mix), selection by (a) agent-authored repro test outcomes, (b) targeted existing-test signal, (c) diff-level LLM judge panel; emit the winner's patch. Requires cheap headless runs (landed) + trajectory logs (§8).

### 6. Thinking logs & memory→rules (new capabilities)

- **Persist reasoning**: every `reasoning-delta` is captured per step into the trace store + trajectory JSONL (today it's rendered dim and discarded). Uses: `/replay` shows thinking; judges may read the final step's reasoning; a post-turn **distiller** mines thinking logs for durable lessons ("assumed X, was wrong") → memory candidates with provenance.
- **Memory→rule promotion**: memories carry salience (exists: `memory salience/promote/candidates`). New: when a lesson repeats (N gotchas with the same signature) or salience crosses a threshold, the CLI proposes promotion → an **enforced rule** in `.oxagen/rules/` (Tier-1 prompt injection + Tier-2 tool-gate guard — enforcement machinery exists today on the legacy path; moves into the engine with §2). Promotion is user-approved (survey tool), demotion tracked. Bench profile: memory off (isolation, landed).

### 7. Orchestration: fleet, commits, PRs, comms

- **Parallel-optimized planner**: planner emits a task DAG (explicit `dependsOn`, declared file scopes). Scheduler runs independent tasks concurrently; unknown-file tasks are treated as touches-everything (never the current vacuous `files: []`).
- **Fleet safety**: `--isolate` (worktree per agent) defaults ON for write-capable concurrency > 1; dependent tasks rebase on the integration branch (not a frozen base ref); integration branch is merged back/surfaced at the end; cancel drains in-flight agents and checkpoints dirty trees before worktree removal. Headless `oxagen agents --json` (no TTY) for CI and for best-of-N fan-out.
- **Fleet subagents run the engine** (judged/enhanced), not the bare legacy loop.
- **Commit ledger (never lose work)**: agents commit immediately and frequently with `--no-verify` on their branch/worktree; every commit is recorded in the local DuckDB store: `(commit_hash, branch, task_id, trace_id, files, timestamp)`. `oxagen recover` lists ledger entries and restores any hash into a worktree. Final verification pass (typecheck + targeted tests + judge) runs before a PR is opened — dirty history is fine, broken PRs are not.
- **PR/CI monitor**: after PR creation the CLI watches checks (`gh` polling); failures trigger a bounded fix-to-green loop (fetch failing job log → diagnose → patch → push). When green, the agent **asks the user** (survey) whether to keep monitoring and auto-merge/close; monitoring state persists across sessions via the daemon.
- **Comms — the user never wonders what's happening**: one event vocabulary (stage/tool start-end/commit/push/PR/check/judge/compaction/retry) powering (a) the REPL status line + activity feed, (b) `--output-format stream-json`, (c) background notifications from monitors. Every long-running operation emits a start line, heartbeat progress, and an outcome line. The ThinkingIndicator gets mounted; `/hud` gets rendered or deleted.

### 8. Observability & efficiency

- **Trajectory JSONL** per run: steps, tool calls/results (capped), usage, cost, retries, compactions, judge verdicts — the substrate for failure-bucket analysis and best-of-N selection. Machine-readable cost line for the bench adapter (replaces the fragile stderr regex).
- **Prompt-cache discipline**: stable system prefix (exists — keep through compaction); volatile context rides as user messages.
- **Token efficiency**: headless prompt profile (no narration), tool-output budgets, read-dedup ("file unchanged since last read"), compaction. Cost/token meter on ALL paths (metered wrapper now includes one-shot).
- Default-model single source (catalog), context-pressure % in the status line.

### 9. SWE-bench run profile (config, not fork)

`--mode bypass --output-format stream-json --max-steps 200`, pinned worker model + high effort, memory OFF, judge ON with evidence gate (or `--no-pipeline` for ablation), headless prompt profile, per-instance wall cap in the harness, `OXAGEN_ALLOW_NO_SESSION=1` + `AI_GATEWAY_API_KEY`. The retired client graph-upsync path is absent rather than benchmark-disabled. Ablations the harness supports: ±pipeline, ±code-graph, ±best-of-N, model matrix.

### 10. Cleanups bound to this spec

Delete the ~5.4k LOC certain-dead inventory (audit §Dead code); fix `daemon start` for npm installs; daemon exit codes; command-surface consistency (shared helpers, one login-gate message, `-l` collision, `--json` everywhere incl. `settings`/`graph search`); REPL: coalesced rendering + memo, input editor (cursor/history/paste), slash catalog as single source of truth, transcript/history caps, `oxagen view` de-mocked or labeled demo; coverage includes `.tsx`; `@inkjs/ui` removed.

### Non-goals

- On-device model as the bench coordinator (cost lever, not score lever — stays for dev UX).
- Platform metering parity for bench runs (bench is BYOK by design).
- TUI visual redesign beyond the fixes above.

## Plan — `03-plan.md`

## Oxagen CLI — Build Plan (phased)

Branch: `feat/cli-swe-bench-hardening` (worktree `../oxagen-cli-bench`). Commit each unit immediately with `--no-verify` + explicit pathspecs (contested tree); push regularly; narrow test runs only (`../../node_modules/.bin/vitest run <file>`), never a full suite. `pnpm gate` once before PR.

### Phase 0 — Unblock the bench ✅ DONE (this branch)

- ✅ `OXAGEN_ALLOW_NO_SESSION=1` → synthetic bench session (`lib/session.ts`) + tests.
- ✅ `createGatewayAgentAi` gateway-direct port (per-vendor reasoning options) auto-selected for synthetic sessions in one-shot + REPL; one-shot wrapped in `createMeteredAi` + tests.
- ✅ Tool-progress fix: engine emits tool lifecycle from fullStream parts; one-shot + legacy guards defer while tools run; per-tool timeout backstop; bash wrapper honors `timeout_ms` + tests.
- ✅ `--output-format text|json|stream-json` + `--max-steps` + result envelope + tests.
- ✅ Untracked files in `workspace.diff()`; top-level error net (`index.tsx`).
- ✅ `OXAGEN_DISABLE_MEMORY=1` bench-adapter default (instance isolation).

Exit criterion (remaining): a single real SWE-bench instance runs end-to-end and emits a non-empty patch envelope. → Phase 4 smoke.

### Phase 1 — Core-loop hardening (the score-critical phase)

Engine `packages/agent-engine`. Land the explicit **step-driver** first; everything else hangs off step boundaries.

1. **Step-driver**: replace monolithic `streamText(stopWhen:256)` with a loop making one model call per step, accumulating messages explicitly, emitting per-step events. Keep prompt-cache-stable system prefix. Tests: N-step fixture, abort mid-step, usage accounting.
2. **Retry+backoff** on retryable model/stream errors, resume from last completed step, per-turn retry budget, abort respected. Tests: injected 429 then success; abort not retried.
3. **Compaction**: token estimator; at ~80% context window summarize old tool results (keep last N steps verbatim). `context_length_exceeded` → hard-trim + one retry. Tests: synthetic overflow compacts and continues; overflow-after-compaction recovers not wedges.
4. **Global tool-output budget** + eviction; **middle-out truncation** (head+tail). Tests: cumulative cap evicts oldest; pytest-tail preserved.
5. **Loop detection** + **repairToolCall**. Tests: 3 identical failing calls → nudge; malformed call repaired.
6. **Tool precision**: read_file line numbers; edit_file fuzzy-match failure feedback + replace_all; rg-backed grep/glob + Python ignore set. Tests each.
7. **Injection seams** in engine runTurn: rules/hooks/MCP/timeout-policy; wire from CLI adapters (parity with legacy). Tests: a rule guard denies on the engine path.
8. **Prompt profiles**: `headless` (verification-first, no narration) vs `interactive`; repro→fix→test→regression protocol. Tests: profile selection; headless omits narration lines.
9. **Bash signal threading**: AbortSignal → `runShellCommandBuffered` → killProcessTree on abort. Test: aborted turn kills the subtree.

Exit: 200-step synthetic turn survives injected 429s + stream drop + context pressure; targeted engine tests green.

### Phase 2 — Engine unification + dead-island removal

1. Route `--agent` one-shot + fleet through engine `runTurn` (bare optional). Delete `agent/loop.ts` + duplicated tools/router/prompt/planner; export shared helpers from the engine.
2. Move `shell-runner` → `lib/exec`.
3. Harvest verifyWork gate + plan tool + survey + monitors into the engine; then delete `apps/cli/src/{orchestrator,pipeline,monitors,contracts}` and the other certain-dead files (audit inventory, ~5.4k LOC). Resolve the two dangling type-only refs in `lib/config.ts`.
4. Unify tool registry (code_graph + code_map + graph_query available regardless of path).
5. `vitest.config.ts` coverage includes `.tsx`; reset thresholds per ratchet; remove `@inkjs/ui`.

Exit: one loop; `pnpm --filter @oxagen/cli typecheck` + affected tests green; dead inventory gone.

### Phase 3 — Verification + new capabilities

1. **Evidence-based judge** (diff + test tails) + **verifyWork gate** wired live; `--candidates N` best-of-N in the bench runner with test/judge selection.
2. **Multi-provider judge panel** (optional N-judge majority/veto).
3. **Thinking-log persistence** (reasoning → trace + JSONL) + post-turn **distiller** → memory candidates.
4. **Memory→rule promotion** (salience/repeat threshold → proposed `.oxagen/rules/` guard, user-approved).
5. **Parallel planner DAG** + fleet safety (isolate-on-default, integration merge-back, cancel-drain) + `oxagen agents --json`.
6. **Commit ledger** (DuckDB: hash/branch/task/trace/files) + `oxagen recover`; final verification pass pre-PR.
7. **PR/CI monitor**: watch → fix-to-green → ask-to-auto-merge; persists via daemon.
8. **Comms**: unified event vocabulary; mount ThinkingIndicator; render or delete `/hud`; slash catalog as single source (parity test); input editor.

Exit: best-of-N run beats single-shot on a sample; PR-monitor drives a real PR to green in a dry run.

### Phase 4 — Bench run + iterate + PR

1. Smoke: 1 instance end-to-end, non-empty patch envelope, cost line parsed.
2. Small set (~20 mixed django/sympy/astropy); baseline resolve rate + failure buckets from trajectories.
3. Iterate on the top failure buckets (usually: patch-scope, test-selection, edit-failure loops).
4. Scale; A/B ±pipeline, ±graph, ±best-of-N, model matrix. Record cost/token per resolved instance.
5. `pnpm gate`; open PR to `main`; `gh run watch` to green; ask user re: merge + monitor.

### Sequencing notes

- Phase 1 is the score-critical path — deepest reasoning, most tests. Phases 1 and 2 can partly overlap (unification simplifies where step-driver changes land; do the step-driver first, unify second to avoid editing soon-deleted code).
- Independent Phase-3 items (thinking logs, memory→rule, commit ledger, PR monitor) can fan out to parallel subagents once Phase 1's engine surface is stable.
- Every phase leaves the branch green and pushed. Bench numbers come only after Phase 1 (compaction/retry) — earlier numbers would be noise from avoidable failures.

## Document — `04-rust-port.md`

## Oxagen CLI — Rust Port Strategy

> **Superseded/expanded by the `oxagen-rust-cli` spec**, which described
> rebuilding the CLI as a standalone, open-source, account-free,
> multi-provider BYOK Rust binary — a different target than this document's
> original framing (a platform-integrated CLI ported to Rust for speed).
> That effort has since been ejected from this monorepo: the agent lives in
> its own repository, and the Open Context Protocol crates live at
> `github.com/macanderson/opencontextprotocol` (the spec directory was
> removed along with `crates/`; see git history for both). The migration
> mechanics below (port-the-spec, golden-trajectory conformance, strangler
> pattern) still apply.

Goal: the most performant (highest resolve rate), most efficient (lowest token burn), and fastest (lowest wall-clock) agentic coding CLI. Rust is the vehicle for *fast* and for a single distributable binary — but the score lives in the **loop logic, prompts, and tool semantics**, which are language-independent. So: **finish and prove the design in TypeScript first, then port a frozen, well-tested spec.** Never port a moving target.

### Guiding principles

1. **Port the spec, not the code.** The TS engine (post-Phase-1) is the executable specification. Its ports are already JSON-serializable and its behaviors are pinned by tests — those tests become the Rust conformance suite.
2. **Strangler pattern, not big-bang.** Stand up `oxagen-core` (Rust) beside the TS CLI; move one capability at a time behind a stable boundary; keep both runnable and cross-tested until Rust is at parity, then flip the default.
3. **Golden trajectories are the contract.** Record real TS-engine runs (deterministic where possible: fixed seed, recorded model responses) as golden JSONL. Rust must reproduce them event-for-event on the same recorded inputs. This is what makes "Rust is tricky" safe — parity is mechanically verifiable, not vibes.
4. **The LLM is the slow part.** Rust's speedup is in everything *around* the model call (fs walks, grep, diff, graph queries, process spawning, JSON, startup) — real for wall-clock and a snappy TUI, but it does not change the resolve rate. Keep expectations honest: Rust buys speed + distribution + memory safety, not accuracy.

### Boundary (where TS and Rust meet during the migration)

The engine already talks to the world through ports. Freeze them as a **versioned JSON protocol** (the same shape as `--output-format stream-json` plus tool-exec requests):

- **Requests** (driver→host): `read_file`, `write_file`, `edit_file`, `list`, `glob`, `grep`, `exec`, `diff`, `code_graph`, `code_map`, `model.stream`, `model.generateObject`, `memory.*`, `trace.record`.
- **Events** (host→driver / driver→UI): stage, text, reasoning, tool-start, tool-result, file-change, judge-verdict, retry, compaction, commit, pr, check.

Transport during migration: line-delimited JSON over stdio between the Rust binary and a thin TS "host" (or vice-versa), so either side can be swapped incrementally. Post-migration the whole thing is one Rust process and the protocol becomes internal trait boundaries.

### Crate layout

```
oxagen-core/           # pure loop: step-driver, compaction, retry, budgets, loop-detect.
                       #   No I/O — drives via the Host trait. This is the score.
oxagen-tools/          # Workspace impl: fs, rg-backed grep/glob, diff, process-group exec
                       #   (tokio + nix for signals/pgid — the audit's bash-leak fix, native).
oxagen-model/          # AgentAi over the AI Gateway: streaming SSE, tool-call parsing,
                       #   per-vendor reasoning options, per-call timeout+retry.
oxagen-graph/          # code-graph: tree-sitter (native, not WASM) incl. Python edges; DuckDB.
oxagen-pipeline/       # evaluate→enhance→route→execute→judge→revise; verifyWork; best-of-N.
oxagen-fleet/          # planner DAG, worktree isolation, commit ledger, PR/CI monitor.
oxagen-tui/            # ratatui REPL (maps 1:1 to the event vocabulary).
oxagen-cli/            # clap command tree; the single distributable binary.
oxagen-protocol/      # serde types for the boundary above; shared by every crate + the TS host.
```

### Sequenced migration (each step ships, both stacks cross-tested)

1. **Protocol + golden recorder** (in TS): finalize `oxagen-protocol` shapes; record golden trajectories from the passing TS engine (recorded model responses for determinism).
2. **`oxagen-tools`** first — highest speed win, lowest risk, easiest to verify (fs/grep/diff/exec have exact expected outputs). Run the TS engine against the Rust tools over the protocol; TS tool tests become Rust conformance tests. Native process-group kill + signal threading is cleaner in Rust than the Node detached-pgid dance.
3. **`oxagen-model`** — SSE streaming + tool-call parsing + reasoning options. Verify against recorded gateway responses.
4. **`oxagen-core`** — the step-driver/compaction/retry/budget logic. Replay golden trajectories: Rust core + recorded model + Rust tools must reproduce the TS event stream exactly. **This is the crux** — port it last among the engine internals, with the most tests, because it is the score.
5. **`oxagen-graph`** — tree-sitter native (drop WASM); parity-check symbol/edge extraction against the TS builder on a fixture repo, Python included.
6. **`oxagen-pipeline`** + **`oxagen-fleet`** — evaluate/judge/best-of-N; planner DAG + ledger + PR monitor.
7. **`oxagen-tui`** (ratatui) + **`oxagen-cli`** (clap) — last; the loop must be proven headless before a TUI rides on it. Flip the default binary; keep the TS CLI as an oracle for one release.

### Conformance & CI

- **Golden-trajectory replay** in CI: same recorded inputs → byte-identical event stream (TS ⇄ Rust). A divergence fails the build with the first differing event.
- **Bench parity gate**: Rust must match TS resolve rate on the sample set (±noise) before the default flips; same harness (`bench/swe-bench`), same profile.
- **Perf gates**: startup time, cold grep over a large repo, diff of a big change, TUI frame budget — Rust must beat the TS baseline (the point of the port) and never regress.
- **Property tests** for compaction (never drops a still-referenced tool result), budget eviction (monotonic), edit-match (fuzzy fallback never corrupts).

### What Rust changes vs. what it doesn't

- **Faster**: startup (no Node warmup), fs/grep/diff/graph (native + parallel via rayon/tokio), single static binary (no node_modules), lower memory, snappier TUI.
- **Safer**: process-group/signal handling, no unhandled-rejection class of bugs, deterministic resource cleanup (RAII worktrees/temp files).
- **Unchanged**: resolve rate (that's prompts + loop logic + model — ported faithfully, verified by golden trajectories). Token burn improves only insofar as the ported compaction/budget logic runs identically.

### Risk register

- **Streaming/tool-call parsing drift** across AI-SDK vs a Rust client → mitigate with recorded-response conformance tests before `oxagen-core` moves.
- **tree-sitter grammar parity** (WASM vs native versions) → pin grammar versions; fixture-diff the symbol/edge output.
- **Model nondeterminism** makes live parity noisy → determinism only claimed on recorded inputs; live comparison is statistical (bench parity gate), not exact.
- **Porting a moving target** → hard rule: freeze the TS spec (tag it) before step 4; spec changes go to TS first, re-record goldens, then Rust.
