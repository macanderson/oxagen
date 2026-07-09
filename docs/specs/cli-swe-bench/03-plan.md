# Oxagen CLI — Build Plan (phased)

Branch: `feat/cli-swe-bench-hardening` (worktree `../oxagen-cli-bench`). Commit each unit immediately with `--no-verify` + explicit pathspecs (contested tree); push regularly; narrow test runs only (`../../node_modules/.bin/vitest run <file>`), never a full suite. `pnpm gate` once before PR.

## Phase 0 — Unblock the bench ✅ DONE (this branch)

- ✅ `OXAGEN_ALLOW_NO_SESSION=1` → synthetic bench session (`lib/session.ts`) + tests.
- ✅ `createGatewayAgentAi` gateway-direct port (per-vendor reasoning options) auto-selected for synthetic sessions in one-shot + REPL; one-shot wrapped in `createMeteredAi` + tests.
- ✅ Tool-progress fix: engine emits tool lifecycle from fullStream parts; one-shot + legacy guards defer while tools run; per-tool timeout backstop; bash wrapper honors `timeout_ms` + tests.
- ✅ `--output-format text|json|stream-json` + `--max-steps` + result envelope + tests.
- ✅ Untracked files in `workspace.diff()`; top-level error net (`index.tsx`).
- ✅ `OXAGEN_DISABLE_MEMORY=1` bench-adapter default (instance isolation).

Exit criterion (remaining): a single real SWE-bench instance runs end-to-end and emits a non-empty patch envelope. → Phase 4 smoke.

## Phase 1 — Core-loop hardening (the score-critical phase)

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

## Phase 2 — Engine unification + dead-island removal

1. Route `--agent` one-shot + fleet through engine `runTurn` (bare optional). Delete `agent/loop.ts` + duplicated tools/router/prompt/planner; export shared helpers from the engine.
2. Move `shell-runner` → `lib/exec`.
3. Harvest verifyWork gate + plan tool + survey + monitors into the engine; then delete `apps/cli/src/{orchestrator,pipeline,monitors,contracts}` and the other certain-dead files (audit inventory, ~5.4k LOC). Resolve the two dangling type-only refs in `lib/config.ts`.
4. Unify tool registry (code_graph + code_map + graph_query available regardless of path).
5. `vitest.config.ts` coverage includes `.tsx`; reset thresholds per ratchet; remove `@inkjs/ui`.

Exit: one loop; `pnpm --filter @oxagen/cli typecheck` + affected tests green; dead inventory gone.

## Phase 3 — Verification + new capabilities

1. **Evidence-based judge** (diff + test tails) + **verifyWork gate** wired live; `--candidates N` best-of-N in the bench runner with test/judge selection.
2. **Multi-provider judge panel** (optional N-judge majority/veto).
3. **Thinking-log persistence** (reasoning → trace + JSONL) + post-turn **distiller** → memory candidates.
4. **Memory→rule promotion** (salience/repeat threshold → proposed `.oxagen/rules/` guard, user-approved).
5. **Parallel planner DAG** + fleet safety (isolate-on-default, integration merge-back, cancel-drain) + `oxagen agents --json`.
6. **Commit ledger** (DuckDB: hash/branch/task/trace/files) + `oxagen recover`; final verification pass pre-PR.
7. **PR/CI monitor**: watch → fix-to-green → ask-to-auto-merge; persists via daemon.
8. **Comms**: unified event vocabulary; mount ThinkingIndicator; render or delete `/hud`; slash catalog as single source (parity test); input editor.

Exit: best-of-N run beats single-shot on a sample; PR-monitor drives a real PR to green in a dry run.

## Phase 4 — Bench run + iterate + PR

1. Smoke: 1 instance end-to-end, non-empty patch envelope, cost line parsed.
2. Small set (~20 mixed django/sympy/astropy); baseline resolve rate + failure buckets from trajectories.
3. Iterate on the top failure buckets (usually: patch-scope, test-selection, edit-failure loops).
4. Scale; A/B ±pipeline, ±graph, ±best-of-N, model matrix. Record cost/token per resolved instance.
5. `pnpm gate`; open PR to `main`; `gh run watch` to green; ask user re: merge + monitor.

## Sequencing notes

- Phase 1 is the score-critical path — deepest reasoning, most tests. Phases 1 and 2 can partly overlap (unification simplifies where step-driver changes land; do the step-driver first, unify second to avoid editing soon-deleted code).
- Independent Phase-3 items (thinking logs, memory→rule, commit ledger, PR monitor) can fan out to parallel subagents once Phase 1's engine surface is stable.
- Every phase leaves the branch green and pushed. Bench numbers come only after Phase 1 (compaction/retry) — earlier numbers would be noise from avoidable failures.
