# Oxagen CLI — Gap Audit (2026-07-02)

Six parallel audits (architecture, core loop, REPL/TUI, command surface, pipeline/bench readiness, dead code) over `apps/cli` (~52k LOC) + `packages/agent-engine`, with the highest-stakes claims re-verified by direct file reads. Items marked **✅ FIXED** landed on `feat/cli-swe-bench-hardening` on 2026-07-02.

## How the CLI actually executes (ground truth)

- **Primary loop**: `@oxagen/agent-engine` `runTurn` (`packages/agent-engine/src/pipeline/index.ts`) — evaluate → enhance → route → execute (`runCodingAgent`) → judge → revise. Drives the REPL and plain one-shot. Port-based (AgentAi/Workspace/Memory/CodeGraph/Trace), fully headless-capable.
- **Legacy loop**: `apps/cli/src/agent/loop.ts` `runAgent` — direct `streamText`; drives only `--agent` one-shot and the fleet. Duplicates tools/router/prompt/helpers, and diverges (rules guards, hooks, MCP tools, per-tool timeouts wired here but NOT on the engine path).
- **Dead island**: `apps/cli/src/{orchestrator,pipeline,monitors,contracts}` (~4,045 LOC) — pre-migration brain, superseded by agent-engine (PR #267), zero live importers.
- **Bench harness already exists**: `bench/swe-bench` + `bench/terminal-bench` (Harbor, SWE-bench Verified default, compare.sh, ClickHouse dashboard) — was blocked by two CLI-side P0s (below, both fixed).

## P0 — bench blockers

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

## Core-loop correctness (engine + legacy)

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

## Fleet / multi-agent (the "outperform" lever, currently unsafe)

- **[P1] Default is shared-tree concurrency with vacuous locks** — `--isolate` defaults false; ad-hoc tasks carry `files: []` so `task.files.some(...)` never serializes anything: N agents write one tree. `program.tsx:179`, `fleet/orchestrator.ts:133,231`.
- **[P1] `--isolate` integration branch is never merged back or surfaced** — a bench harness can't collect the patch; Ctrl-C force-removes worktrees before agents drain (work lost). `tui/fleet-view/index.tsx:86`, `fleet/orchestrator.ts:288`.
- **[P1] Fleet runs the bare legacy loop** — no evaluate/enhance/judge for subagents; also BYOK-gateway direct, bypassing the login gate the main path enforces (inconsistent policy, tracked as ADR-019 task B4).
- **[P0][commands] Fleet is TTY-locked** — `oxagen agents` renders Ink unconditionally (`useInput` requires raw mode): the flagship multi-agent feature cannot run in CI/headless at all. `tui/fleet-view/index.tsx:77`.
- Dependent tasks spawn from a frozen base ref (`git-isolation.ts:218`); unchecked `worktree remove`/`merge --abort` exit codes.

## Command surface

Positive: all 21 command files are real implementations — zero stubs/TODO/mock markers; all registered; login has a clean headless path (`--token`, env vars).

- **[P0] No headless fleet mode** (above). **[P0→✅] one-shot output/steps flags** (fixed).
- **[P1] Zero tests on 6 command files + shared transport** (`code`, `config`, `env`, `graph.search`, `graph.status`, `secret`, `lib/api.ts`, `lib/resolve.ts`) — `secret.ts` handles live credentials untested.
- **[P1] `daemon start` broken for published npm installs** — spawns `process.execPath --import tsx <path>.ts`; `tsx` is devDependency-only and dist ships no `.ts`. `daemon/lifecycle.ts:60`.
- **[P1] `daemon stop`/`status` never set a failure exit code.** `daemon/lifecycle.ts:98,133`.
- **[P2]** duplicated helpers (maskToken ×2, splitCsv ×2, org/workspace guard ×4, git plumbing ×2, scaffold regex ×3); two different "not logged in" messages; `-l` flag collision (labels vs limit); `graph search` JSON-only with no flag; six phrasings of `--json` help text; console.log vs process.stdout.write split.

## REPL / TUI

Verified solid: panel-dupe fix complete and dupe-safe; FIFO pump generation-guarding; process-group kill; focus model; async-memory unmount guard.

- **[P1] Per-token full-transcript re-render, un-memoized, + double measureElement per render** — every streamed token re-renders 40–100 components. Coalesce on ~30–60ms timer + `React.memo(MessageView)`. `interactive.tsx:1473,1669`.
- **[P1] `/hud` is a no-op** (toggles state; `<HudPanel>` never rendered) and **ThinkingIndicator is built+tested+never mounted** — during a turn the only signal is a prompt-bar glyph. `interactive.tsx:1054`, `components.tsx:662`.
- **[P1] `/effort` works but is missing from catalog + HELP** (undiscoverable); slash dispatch/HELP/catalog are three independent hardcoded lists with no parity test. `slash/catalog.ts:38`.
- **[P2]** idle Ctrl-C exits immediately (input-abandon footgun); no cursor movement/sent-history/paste handling in the prompt input; transcript + `historyRef` grow unbounded (memory + context); `oxagen view` renders 100% fabricated telemetry labelled "live" with dead hotkey hints; HELP omits 7 shipped commands; copy-pasted spinner/elapsed/statusStyle helpers ×3-4 files.
- **[P3]** argless built-ins matched with `===` (`/help x` → Unknown command); `$` injection in slash `applyArgs`; prefix-only slash menu; catalog never rebuilds mid-session; fleet 10Hz render timer never idles; stale `<Static>` comment.

## Dead code & bloat (10.4% of the CLI is certain-dead)

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

## Plan-vs-reality for the 8-group pipeline plan (`~/Desktop/outputs/oxagen-cli-pipeline`)

1 on-device: DONE (headless unreachable). 2 orchestrator/routing: PARTIAL (engine router live; coordinator-dispatches-workers thesis unbuilt; island dead). 3 context graph: DONE-core (engine enhance; Python edges missing). 4 assist tools: PARTIAL (enhancer+judge live; survey dead-island only). 5 monitors: BUILT-BUT-DEAD. 6 pipeline/verification: PARTIAL (5-step machine IS runTurn; verifyWork evidence gate + plan tool dead-island only; judge advisory, 1 revise round). 7 contracts: ORPHANED. 8 bug fixes: DONE (with the stream-consumption gap now fixed on this branch).
