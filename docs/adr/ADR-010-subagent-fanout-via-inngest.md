# ADR-010 — Subagent fanout via Inngest invoke

**Date:** 2026-05-28
**Status:** Accepted
**Epic:** Agent Runtime

## Context

`agent.subagent.dispatch` spawns N children (up to 16) in parallel,
each running a scoped capability. Two viable approaches: lean on
Inngest's `step.invoke()` fanout, or stand up a separate worker pool
inside the runner that pulls from a per-tenant queue.

## Decision

Use **Inngest `step.invoke()`** for subagent fanout. Each child
runs as a step inside the parent fanout function, checkpointed by
Inngest. The parent waits with `Promise.allSettled` and writes
`agent.subagent_runs` rows as each child completes.

## Alternatives considered

- **Custom worker pool inside `apps/runner`.** Reinvents retries,
  scheduling, observability — everything Inngest already gives us.
- **Spawn child Inngest events and aggregate via DB polling.** Works
  but loses the structural parent-child relationship in Inngest's UI
  and bills two events instead of one fanout.
- **Promise.all in process, no durability.** Loses crash safety; a
  parent crash mid-fanout leaves orphan runs.

## Consequences

- One Inngest function (`apps/runner/src/functions/
  agent.execute-subagent.ts`) handles `agent/subagent.dispatch`.
- Each child runs in its own `step.run(`run-${childId}`, …)` for
  checkpointing.
- Status updates in `agent.subagent_fanouts` (parent) and
  `agent.subagent_runs` (children) keep the UI live.
- Aggregation: `agent.subagent.aggregate` polls
  `agent.subagent_runs` by `fanoutId` until `waitForCompletion`
  or `timeoutMs`.
- Tradeoff: fanout capped by Inngest's per-function step budget. For
  v1 we cap at 16 children; revisit if patterns demand more.
- Tradeoff: child errors don't propagate to the parent immediately —
  the parent fanout function completes with `status: 'partial'`
  even on child failures. The aggregator reports per-child status.
