# ADR-033: Adopt the Stella Rust engine as the platform agent core

- **Status:** Proposed
- **Date:** 2026-07-18
- **Owners:** agent-engine
- **Related:** ADR-021 (inference doctrine — deterministic-before-model),
  ADR-029 (mutation verifier gate), ADR-030 (speculative tool execution),
  ADR-032 (unified chat session state), `docs/specs/agent-engine-v2/`
  (full design)

## Context

The platform's own agent implementation falls short in three ways:

1. The coding loop is **request-scoped and non-durable**: turn state is an
   in-memory `conversation` array inside a 1,856-line Next.js route stream. A
   disconnect or function timeout loses the turn. There is no checkpoint and no
   resume path (`rg 'resume|checkpoint'` over the loop code: zero hits).
2. There is **no hook/event bus**. `packages/agent/src/hooks/runtime.ts` is
   three hardcoded log-only functions; blocking policy exists only as the fixed
   kernel gate order. Plugins cannot register policy.
3. Tool-call parallelism is inherited, not designed: the AI SDK fires every
   tool call in a step without awaiting (`run-tools-transformation.ts`,
   "we don't await the tool execution here"), with **no concurrency cap and no
   mutating-call barrier** — parallel `write_file` + `bash` can interleave.

Meanwhile Stella — the Rust terminal agent at `macanderson/stella` (MIT OR
Apache-2.0) — has the engine we want: a pure, ports-everywhere core
(`stella-protocol` → `stella-core` → `stella-pipeline`) with a
deterministic-first verification ladder (flip oracle), witness authoring with
tamper exclusion, token-drift self-calibrating compaction, read-only-partitioned
concurrent tool dispatch, a real hook bus (observers + blocking policy with
Allow/Deny/RequireApproval/Modify verdicts, fail-closed), circuit-breaker
routing, and one canonical serialized event vocabulary. Its decision logic is
property-tested and I/O-free; every external effect goes through an injected
trait.

What Stella does **not** have is what Oxagen does: the typed capability kernel
(`invoke()` with IAM → billing admission → entitlement → approval gates over
~300 Zod contracts), multi-tenant sandboxing, engram memory, metering→Stripe
billing, and ClickHouse telemetry.

## Decision

Adopt the Stella engine core (`stella-protocol` + `stella-core` +
`stella-pipeline`) as the platform's agent engine, embedded in-process via a
napi-rs binding (`stella-engine-node`), with Oxagen implementing the engine's
ports:

- `Provider` ← `@oxagen/ai` (`streamAgentReply` — metering and gateway intact)
- `ToolExecutor` ← `materializeTools()` output (every tool call still re-enters
  `kernel.invoke()`; **the engine is the brain, the kernel remains the law**)
- `ProviderResolver` ← the market/model router (verified-outcome router slots
  in here unchanged)
- `ContextRecallPort` ← engram's context compiler
- `CommandRunner` ← sandbox exec (flip-oracle test runs inside the tenant
  sandbox)
- `ApprovalGate` ← existing approval rows + `waitForApproval`
- Hook bus ← the new platform extension surface: plugins register blocking
  policy hooks; observers feed ClickHouse

Execution moves off the request path into a durable turn runner: one
`executeTurn()` entrypoint for all surfaces, a persisted `AgentEvent` log as
the canonical run record (converging with ADR-032 session
state), per-step checkpoints, lease-based claims, and resume after crash or
redeploy. SSE becomes a resumable subscription to the event log.

Sequencing is two-track so the payoff is not gated on Rust: Track 1 (TS-only)
lands the single entrypoint, durable runner, capped/partitioned tool dispatch,
and `code_graph` speculation; Track 2 lands the embedded core behind a flag,
validated in shadow mode against live traffic. Full design and
phases: `docs/specs/agent-engine-v2/`.

## Consequences

- One engine for every surface. Licensing is clean (MIT OR Apache-2.0 consumed by proprietary code); pin by
  git rev like the OCP crates.
- The TS pipeline (1,968 lines), loop heuristics, and the route-inlined turn
  logic are retired after parity; ADR-029's mutation gate is absorbed by the
  witness + flip-oracle verification plane.
- ADR-030 speculation survives unchanged — it wraps the ToolSet and composes
  under the engine's `ToolExecutor`.
- New operational surface: prebuilt native binaries in the worker image, and a
  long-lived worker pool (the request path no longer hosts the loop).
- Upstream work lands in Stella (step-scoped `run_step` API for external
  checkpointing, host-emitted bus lifecycle events, cancellation token); Mac
  owns both repos, so this is coordination-cheap.

## Alternatives considered

- **Rust sidecar service** (JSONL `AgentEvent` + reverse tool-call protocol):
  identical port surface, but adds a network hop to every tool/model callback
  and a new stateful service to operate. Kept as fallback — the ports make the
  transport swappable.
- **Pure TS port of Stella's designs:** no FFI risk, but forfeits the
  property-tested implementation, and the two engines drift forever. Rejected
  as the end-state; Track 1 deliberately ports the *architecture* (seams,
  durability) so the swap is small.
