# Agent Engine V2 — Phased Plan

Phases are ordered by dependency, not calendar. Each phase is shippable alone
and none of the Track-1 phases depend on Rust. "Parity gate" always means: the
arena/SWE-bench suite (`bench/`) run old-vs-new on the same tasks, plus shadow
traffic on the platform, with resolve-rate ≥ baseline and cost/turn ≤ baseline.

## Phase 0 — Quick wins in the current TS engine (days, no restructuring)

1. **`code_graph` joins speculation (ADR-030).**
   - Add `code_graph` to `SPECULATABLE_TOOLS` (`speculate/layer.ts:35`) for
     `search` / `file_symbols` / `dependents` / `imports` only —
     `semantic_search` is cache-servable but never prefetched (embedding spend
     on unconsumed predictions).
   - Predictor rules (`speculate/predictor.ts`): after `read_file`/`grep` on a
     path → predict `code_graph {file_symbols, dependents}` for it; after
     `code_graph` output listing paths → predict `read_file` of top hits.
   - Existing invalidate-all-on-mutation covers staleness; no metering impact
     (code_graph is a workspace tool, not a kernel capability).
2. **Guard tool-call parallelism.** Confirmed: the AI SDK executes all tool
   calls in a step concurrently, unawaited, uncapped, including mutating tools
   (`ai@6.0.224` `run-tools-transformation.ts:351-386`). Interim guard in
   `engine.ts`/tool wrapping: concurrency cap (8) + serialize
   `MUTATING_TOOL_NAMES` behind a barrier (Stella dispatch semantics,
   `driver.rs:702-759`). This becomes engine-owned in Phase 3.
3. **Mark `read_only` on materialized tools** (from capability
   sensitivity/mutation metadata) — needed by item 2 now and by the engine's
   partitioned dispatch later.

Exit: speculation hit-rate telemetry includes code_graph; no concurrent
mutating tool executions observable in `tool_invocations`.

## Phase 1 — One entrypoint (Track 1)

- `packages/agent-runner` with `executeTurn(runSpec)`; chat route, `apps/api`
  chat + A2A, and `agent.repo.edit` all call it. The god-routes shrink to
  parse → call → subscribe.
- No behavior change; this is seam-creation. Integration test "prompt → run →
  tool → events → persist" becomes writable for the first time.

Exit: zero direct `runCodingAgent` imports outside `agent-runner`; one
integration test exercising the full path.

## Phase 2 — Durable runs (Track 1)

- `agent_runs` + append-only `agent_events` (`UNIQUE(run_id, seq)`) +
  content-addressed blob store (reuse `packages/replay` RecordStore pattern).
- Worker pool with `FOR UPDATE SKIP LOCKED` claims + lease heartbeat (pattern
  already proven in `agent.execute-subagent.ts`); Inngest keeps dispatch,
  `cancelOn`, lease-sweep.
- Per-step checkpoint (messages digest + budget + loop state) in the same
  transaction as the event append; resume-from-checkpoint on re-claim.
- SSE = replayable subscription from last seq; reconnect works mid-run.
- ClickHouse ingestion + ADR-028 replay re-pointed at the event log.

Exit: kill -9 a worker mid-run → run completes on another worker; client
reconnect mid-run loses zero events; chat.persist-stream retired or reduced to
a projection.

## Phase 3 — Embedded Stella core behind a flag (Track 2)

- Upstream: `stella-engine` facade + `run_step` + `stella-engine-node` (napi)
  + `AgentEvent` TS codegen (work items §6 of spec.md).
- Platform: port adapters (Provider ← streamAgentReply, ToolExecutor ←
  materialized tools + speculation wrap, recall ← engram, CommandRunner ←
  sandbox, ApprovalGate ← approvals), `ENGINE=stella` flag in `agent-runner`.
- Conformance: `validate_stream` over recorded platform event streams in CI.
- Shadow mode: mirror a slice of real runs through the new engine (no user
  visibility), diff outcomes + cost.

Exit: parity gate passes; flag flips for internal org; no P0 for two weeks.

## Phase 4 — Verification plane + bus in production

- Ladder on for code-mode runs (witness → flip oracle → SubmitFast/revise →
  judge-on-inconclusive), tests via sandbox CommandRunner; scope review →
  approval rows.
- Bus attached in the worker: plugins' `policyHooks` contribution (blocking,
  9-name allowlist), observers replace the three hardcoded hooks
  (`hooks/runtime.ts`) for execution_logs/tool_invocations/engram capture.
- Flip-oracle verdicts start feeding the verified-outcome router's history.

Exit: SubmitFast rate and judge-invocation rate on dashboards; a demo plugin
registering a Deny/RequireApproval policy hook end-to-end; ADR-029 gate
retired in favor of the ladder.

## Phase 5 — Consolidation

- Delete `pipeline/index.ts`, loop heuristics superseded by the engine, and
  route-inlined turn logic. `engine.ts` remains only as the CLI-compat shim
  until the CLI also fronts `agent-runner`.
- `docs/specs/oxagen-rust-cli/` marked superseded (the Rust agent exists —
  it is Stella; the platform now embeds it).

Exit: one engine implementation reachable from every surface; LOC delta
strongly negative.
