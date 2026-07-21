# Oxagen CLI — Target Spec: beat Claude Code on SWE-bench (and everything else)

## 1. Mission & success criteria

Primary: **oxagen ≥ Claude Code on SWE-bench Verified with the same worker model**, measured with the in-repo Harbor harness (`bench/swe-bench`) against the official 500-instance set.

| Metric | Target |
|---|---|
| SWE-bench Verified resolve rate | ≥ Claude Code baseline (same model), then beat it via best-of-N selection |
| Harness failure rate (non-model errors: crashes, timeouts, empty patches) | < 1% of instances |
| Wall-clock per instance | ≤ Claude Code's, at parity settings |
| Tokens + $ per resolved instance | measured on every run; regression-gated |
| Long-trajectory stability | 200-step synthetic turn survives injected 429s/stream drops/context pressure |

Secondary: the same engine powers a best-in-class interactive CLI (single code path — no bench-only forks).

## 2. Architecture: one engine, ports, no duplicates

- `@oxagen/agent-engine` is **the only loop**. `--agent` one-shot and the fleet route through `runTurn`/`runCodingAgent`; `apps/cli/src/agent/loop.ts` + duplicated tools/router/prompt/planner are deleted.
- Delete the dead island (`orchestrator/`, `pipeline/`, `monitors/`, `contracts/` in apps/cli, ~4k LOC) after harvesting: **verifyWork evidence gate**, **plan tool**, **survey tool**, **monitors** concepts move into the engine pipeline.
- Engine gains injection seams the legacy loop had and the live path silently dropped: workspace rules (Tier-1 prompt + Tier-2 guard denies), settings hooks (Session/PreToolUse/PostToolUse), MCP tools, per-tool timeout policy.
- `shell-runner` moves out of `repl/` (dependency inversion) into `lib/exec`; AbortSignal threads from turn → tool → process group so an aborted turn kills its bash subtree.
- All ports stay JSON-serializable — this is the Rust seam (see 04-rust-port.md).

## 3. Core loop: the explicit step-driver

Replace the single monolithic `streamText(stopWhen: stepCountIs(256))` call with an engine-owned step loop (one model call per step, messages accumulated explicitly). This single change unlocks, at step boundaries:

1. **Retry with backoff+jitter** on 429/5xx/network/stream errors — resume from the last completed step instead of losing the turn. Retry budget per turn; abort respected instantly.
2. **Compaction**: token accounting per step (usage + estimator). At ~80% of the model's context window: summarize old tool results (keep the last N steps verbatim + a structured summary of earlier work: files read/edited, key findings, test status), preserving the stable system-prefix for prompt caching. On a provider `context_length_exceeded` despite that: hard-trim + one retry, never wedge.
3. **Global tool-output budget**: cumulative cap with eviction of oldest bulky results (replaced by one-line stubs: "output evicted — re-run if needed").
4. **Loop detection**: N identical failing tool calls → inject a corrective nudge; M repeats → stop with a structured failure.
5. **Malformed-call repair** (`experimental_repairToolCall` or equivalent) instead of relying on SDK defaults.
6. **Per-step trajectory JSONL** (see §8) and checkpoint/resume.

Timeout policy (landed on this branch, keep): no wall-clock turn cap; progress-based guards that treat in-flight tools as progress; every tool carries a timeout backstop; bash honors its declared `timeout_ms` (≤600s) + grace.

## 4. Tools: precision + speed on foreign repos

- **read_file**: `cat -n` line numbers; default line cap with explicit range indication.
- **edit_file**: structured failure feedback (closest fuzzy match with line numbers, whitespace-normalized hint, occurrence list), `replace_all` option, optional multi-edit. Failure messages teach the retry.
- **bash**: middle-out truncation (keep head + tail — failure summaries live at the tail); exit code always included; signal-aware.
- **grep/glob**: shell to `rg` when present (respects .gitignore natively; JS walker fallback); Python-aware ignore set (`.venv`, `__pycache__`, `.tox`, `.mypy_cache`, `.pytest_cache`, `*.egg-info`, `.eggs`).
- **code_graph**: Python import-edge resolution in the daemon builder; when graph coverage for the repo's language is thin, the system prompt automatically demotes graph-first guidance (honest capability signaling).
- **Patch capture**: untracked files included (landed); surface capture failures instead of silent `""`; raise/stream past 50MB.

## 5. Verification: evidence, not self-report

- **Evidence-based judge**: judge input = the actual `git diff` + executed commands with tail output (esp. test runs) — not the agent's prose. Verdict requires evidence categories (tests-run? repro-shown? regressions-checked?).
- **verifyWork gate** (harvested from the dead island): when on, a turn is not "complete" until evidence exists; judge findings drive bounded revise rounds (configurable > 1 for bench).
- **Multi-provider judge panels**: worker on Anthropic ⇒ judge on OpenAI/Google top models (already the single-judge default; extend to an optional N-judge panel with majority/veto for high-stakes runs and best-of-N selection). Judge ≠ worker enforced (exists).
- **System-prompt protocol** (both engine profiles): reproduce → write/keep a failing test → fix → re-run targeted tests → check regressions → final diff review. Two prompt profiles: `interactive` (narration) and `headless` (no narration tax; verification-first).
- **Best-of-N (the beat-Claude-Code lever)**: bench runner `--candidates N` — N independent trajectories (temperature/seed/model-mix), selection by (a) agent-authored repro test outcomes, (b) targeted existing-test signal, (c) diff-level LLM judge panel; emit the winner's patch. Requires cheap headless runs (landed) + trajectory logs (§8).

## 6. Thinking logs & memory→rules (new capabilities)

- **Persist reasoning**: every `reasoning-delta` is captured per step into the trace store + trajectory JSONL (today it's rendered dim and discarded). Uses: `/replay` shows thinking; judges may read the final step's reasoning; a post-turn **distiller** mines thinking logs for durable lessons ("assumed X, was wrong") → memory candidates with provenance.
- **Memory→rule promotion**: memories carry salience (exists: `memory salience/promote/candidates`). New: when a lesson repeats (N gotchas with the same signature) or salience crosses a threshold, the CLI proposes promotion → an **enforced rule** in `.oxagen/rules/` (Tier-1 prompt injection + Tier-2 tool-gate guard — enforcement machinery exists today on the legacy path; moves into the engine with §2). Promotion is user-approved (survey tool), demotion tracked. Bench profile: memory off (isolation, landed).

## 7. Orchestration: fleet, commits, PRs, comms

- **Parallel-optimized planner**: planner emits a task DAG (explicit `dependsOn`, declared file scopes). Scheduler runs independent tasks concurrently; unknown-file tasks are treated as touches-everything (never the current vacuous `files: []`).
- **Fleet safety**: `--isolate` (worktree per agent) defaults ON for write-capable concurrency > 1; dependent tasks rebase on the integration branch (not a frozen base ref); integration branch is merged back/surfaced at the end; cancel drains in-flight agents and checkpoints dirty trees before worktree removal. Headless `oxagen agents --json` (no TTY) for CI and for best-of-N fan-out.
- **Fleet subagents run the engine** (judged/enhanced), not the bare legacy loop.
- **Commit ledger (never lose work)**: agents commit immediately and frequently with `--no-verify` on their branch/worktree; every commit is recorded in the local DuckDB store: `(commit_hash, branch, task_id, trace_id, files, timestamp)`. `oxagen recover` lists ledger entries and restores any hash into a worktree. Final verification pass (typecheck + targeted tests + judge) runs before a PR is opened — dirty history is fine, broken PRs are not.
- **PR/CI monitor**: after PR creation the CLI watches checks (`gh` polling); failures trigger a bounded fix-to-green loop (fetch failing job log → diagnose → patch → push). When green, the agent **asks the user** (survey) whether to keep monitoring and auto-merge/close; monitoring state persists across sessions via the daemon.
- **Comms — the user never wonders what's happening**: one event vocabulary (stage/tool start-end/commit/push/PR/check/judge/compaction/retry) powering (a) the REPL status line + activity feed, (b) `--output-format stream-json`, (c) background notifications from monitors. Every long-running operation emits a start line, heartbeat progress, and an outcome line. The ThinkingIndicator gets mounted; `/hud` gets rendered or deleted.

## 8. Observability & efficiency

- **Trajectory JSONL** per run: steps, tool calls/results (capped), usage, cost, retries, compactions, judge verdicts — the substrate for failure-bucket analysis and best-of-N selection. Machine-readable cost line for the bench adapter (replaces the fragile stderr regex).
- **Prompt-cache discipline**: stable system prefix (exists — keep through compaction); volatile context rides as user messages.
- **Token efficiency**: headless prompt profile (no narration), tool-output budgets, read-dedup ("file unchanged since last read"), compaction. Cost/token meter on ALL paths (metered wrapper now includes one-shot).
- Default-model single source (catalog), context-pressure % in the status line.

## 9. SWE-bench run profile (config, not fork)

`--mode bypass --output-format stream-json --max-steps 200`, pinned worker model + high effort, memory OFF, judge ON with evidence gate (or `--no-pipeline` for ablation), headless prompt profile, per-instance wall cap in the harness, `OXAGEN_ALLOW_NO_SESSION=1` + `AI_GATEWAY_API_KEY`. The retired client graph-upsync path is absent rather than benchmark-disabled. Ablations the harness supports: ±pipeline, ±code-graph, ±best-of-N, model matrix.

## 10. Cleanups bound to this spec

Delete the ~5.4k LOC certain-dead inventory (audit §Dead code); fix `daemon start` for npm installs; daemon exit codes; command-surface consistency (shared helpers, one login-gate message, `-l` collision, `--json` everywhere incl. `settings`/`graph search`); REPL: coalesced rendering + memo, input editor (cursor/history/paste), slash catalog as single source of truth, transcript/history caps, `oxagen view` de-mocked or labeled demo; coverage includes `.tsx`; `@inkjs/ui` removed.

## Non-goals

- On-device model as the bench coordinator (cost lever, not score lever — stays for dev UX).
- Platform metering parity for bench runs (bench is BYOK by design).
- TUI visual redesign beyond the fixes above.
