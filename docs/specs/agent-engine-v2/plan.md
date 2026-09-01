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
   (`ai@7.0.14` `execute-tools-from-stream.ts:200-205`; same in `ai@6`
   `run-tools-transformation.ts`). Interim guard in
   `engine.ts`/tool wrapping: concurrency cap (8) + serialize
   `MUTATING_TOOL_NAMES` behind a barrier (Stella dispatch semantics,
   `driver.rs:702-759`). This becomes engine-owned in Phase 3 — it now has;
   see that phase.
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

**Deployment: done.** `packages/agent-worker` now ships to the shared node on
the same contract as api/app/docs/mcp — a `start` script, a single esbuild
bundle, an `oxagen-run.json` manifest, a loopback `/healthz` the node's
post-start poll reads, and a `worker` leg in the `deploy-node` matrix. The
tarball carries a `stella-serve` binary built at the pinned version, so
selecting the Stella engine for the worker is one Parameter Store flag.

Exit: kill -9 a worker mid-run → run completes on another worker; client
reconnect mid-run loses zero events; chat.persist-stream retired or reduced to
a projection. **Still open**: chat runs inline on the request path, so the
reconnect and crash-survival halves are not yet exercised in production.

## Phase 3 — Embedded Stella core behind a flag (Track 2)

Flag-selected execution landed in #2549. The default engine is still `ts`;
moving it is a separate decision (#2548), earned by the parity gate below.

- Upstream: `stella-engine` facade + `run_step` + `AgentEvent` TS codegen (work
  items §6 of spec.md).
- Platform: port adapters (Provider ← streamAgentReply, ToolExecutor ←
  materialized tools + speculation wrap, recall ← engram, CommandRunner ←
  sandbox, ApprovalGate ← approvals), engine flag in `agent-runner`.
- Conformance: `validate_stream` over recorded platform event streams in CI.
  **Not built.**
- Shadow mode: mirror a slice of real runs through the new engine (no user
  visibility), diff outcomes + cost. **Not built** — #2548.

### Where the shipped engine differs from the sketch above

Four things landed differently from what this phase specified. Each is a
decision, not an implementation detail, so it is recorded here rather than left
to be inferred from the diff.

- **The engine runs as a `stella-serve` sidecar over loopback HTTP, not as
  `stella-engine-node` (napi).** One sidecar per worker *slot*, bound
  `127.0.0.1:0` so the kernel picks the port, with a fresh per-process token
  and `STELLA_SERVE_TOOLS=remote` (`stella/sidecar-pool.ts`). A napi binding
  would have put the engine in-process, and several of stella's credential and
  config knobs are process-global — two tenants sharing one engine process
  would share that state (`serve-surface.md` § "Containment posture"). A
  sidecar per slot keeps them apart.
- **The flag is `OXAGEN_ENGINE`, not `ENGINE`**, and a run's own engine ask
  takes precedence over it (`stella/engine-choice.ts`). An unrecognised value
  throws rather than falling back to `ts`: a deployment that believes it cut
  over and did not is worse than a loud failure. What the driver reads today
  is RunSpec **v1**'s optional `engine` (`turn-driver.ts`, the one
  `executeTurn` call site); RunSpec v2's `engine_policy.requested_engine` is
  declared in the schema but not yet read there, so a v2 run asking for an
  engine still takes the process default. Wiring it is #2544's remaining item.
- **The engine's own budget is armed only when the host can price a call.**
  `configureStellaEngine({ price })` at worker boot injects an
  `@oxagen/billing`-backed pricer, so `CompletionResult.cost_usd` carries real
  dollars and `buildBudgetSpec` sends `observed` instead of `off`
  (`stella/provider-bridge.ts`, `stella/run-stella-turn.ts`). Deliberately not
  `enforced`: the host's `RunCodingAgentOptions.budgetGuard` remains the
  spend authority and metering does not move (§3), so the engine's ceiling is
  a cross-check rather than a second gate. `@oxagen/agent-runner` never
  imports billing — the pricer arrives as an injected function, the same split
  `budgetGuard` already makes.
- **Phase 0 item 2's interim dispatch guard is now engine-owned**, as that item
  anticipated. Stella partitions a step's calls on the `read_only` bit each
  advertised schema carries, derived from the host's
  `MaterializedTools.mutatingToolNames` (`stella/tool-mapping.ts`); the TS
  guard is not applied on the Stella path, since running both would serialize
  twice against a decision the engine has already made.

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
