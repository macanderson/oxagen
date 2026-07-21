# Spec: Graph-Mediated Fanout Results (Blackboard-Lite)

**Status:** Draft
**Owner:** Mac Anderson
**Related:** ADR-010 (subagent fanout via Inngest), ADR-019 (unified agent engine)
**Supersedes on acceptance:** parts of ADR-010's aggregate model → file as ADR-021

> **2026-07 launch update:** Phase 1's compact Postgres summary model remains.
> The later automatic Neo4j execution projection and semantic peer-recall
> extension were retired; durable run evidence is the future projection source.

## Problem — one seam burns most of the fleet's tokens and wall-clock

The platform fanout path relays **every child's full input and output back into the
parent agent's LLM context**:

1. Parent calls `agent.subagent.dispatch` (tool) → Inngest `agent.execute-subagent`
   runs each child via `kernel.invoke` and writes the full result to
   `subagent_runs.outputPayload` (Postgres).
2. Parent calls `agent.subagent.aggregate` (tool) → the handler
   (`packages/agent/src/handlers/agent.subagent.aggregate.ts:179`) returns a
   `children[]` array carrying **each child's complete `input` + `output` payloads,
   un-merged** (contract `packages/oxagen/src/contracts/agent.subagent.aggregate.ts:61-77`),
   plus `aggregatedData`, a naive deep-merge of all outputs.
3. That entire blob is serialized as the tool result and appended to the parent's
   `messages`. For a 20-child fanout with 2–4k-token outputs, **40–80k tokens enter
   the coordinator's context in a single tool result** — and are re-paid as input
   tokens on *every subsequent parent turn*.

Symptoms already visible in the codebase:

- `packages/agent-engine/src/loop-driver.ts` exists largely to mitigate this — it
  structurally compacts messages (`compactMessages()`, line 127) and truncates huge
  tool results when the transcript exceeds `contextWindowFor(model)` (line 100).
  We are paying tokens to ingest data, then paying compute to throw it away.
- If the parent checks a still-running fanout, it gets the partial `children[]`
  each time — the relay cost repeats per poll.
- Parent latency scales with context size: every child output relayed into the
  parent makes the parent's *next* LLM call slower.

The CLI fleet already proves the alternative works. `Fleet.run()`
(`apps/cli/src/agent/fleet/orchestrator.ts:379` and
`packages/agent-engine/src/fleet/index.ts:266`) keeps only a **280-character
summary** per worker plus token counts; full worker text never re-enters a
coordinator LLM. The platform path should behave the same way.

## Goals

1. **Cut coordinator input tokens per fanout by ≥ 80%** on the aggregate seam:
   the parent receives summaries + references, never full payloads by default.
2. **Reduce parent turns/latency**: fewer aggregate polls, smaller prompts per
   parent step, less loop-driver compaction work.
3. **Keep full results retrievable on demand** — a scoped read of exactly one
   child's output when the parent actually needs it.
4. **Zero LLM cost added**: summaries are structural (handler-declared or
   truncation), not model-generated.

## Non-goals (Phase 2+, separate spec)

- Peer-to-peer coordination through the graph (workers reading each other's
  results, claim/lease work nodes, desired-state reconciliation, dynamic
  micro-agent scaling). This spec builds the substrate those need — structured
  result refs + graph projection — without changing the coordination topology.
- Replacing the workflow supervisor (`agent.workflow.supervisor.ts`) planner.
- Changing the CLI fleet (already summary-based).

## Design

### 1. Compact-by-default `agent.subagent.aggregate`

Change the contract output (`packages/oxagen/src/contracts/agent.subagent.aggregate.ts`):

```ts
// children[] item — BEFORE
{ runId, capabilityName, status, input, output, errorReason }

// children[] item — AFTER (default)
{
  runId: string,            // ref for agent.subagent.result.get
  capabilityName: string,
  status: SubagentRunStatus,
  summary: string,          // ≤ 280 chars, structural (see §3)
  outputBytes: number,      // size hint so the model can decide whether to fetch
  errorReason: string | null,
}
```

- `input` is dropped from the child entry entirely — the parent authored it; it is
  already in the parent's context from the dispatch call.
- `aggregatedData` becomes **opt-in** via a new input flag `includeMerged?: boolean`
  (default `false`), and even when requested is hard-capped at **16 KB serialized**;
  above the cap the handler returns `aggregatedData: null` and
  `aggregatedDataTruncated: true`. `conflicts[]` stays — it is computed server-side
  in `mergeOutputs()` (`packages/agent/src/handlers/agent.subagent.aggregate.ts:34-75`)
  and is cheap and genuinely useful signal.
- A transitional input flag `includeOutputs?: boolean` (default `false`) preserves
  the old full-payload behavior for existing callers, with each child `output`
  capped at 8 KB serialized (`outputTruncated: true` marker when clipped).
  Mark deprecated in the contract description; remove after one release cycle.

### 2. New capability: `agent.subagent.result.get` (scoped on-demand read)

The parent fetches one child's full output only when the summary is insufficient.

- **Contract** `packages/oxagen/src/contracts/agent.subagent.result.get.ts`:
  - Input: `{ runId: string }`
  - Output: `{ runId, capabilityName, status, input, output, errorReason,
    startedAt, completedAt }`
  - `mode: "sync"`, `requiresApproval: false`, riskLevel low, read-only.
- **Handler** in `packages/agent/src/handlers/`: reads `subagent_runs` by
  `publicId` via `withTenantDb` (org + workspace scoped — a run from another
  tenant must 404, not 403). No IAM beyond org membership; it exposes nothing the
  dispatching agent didn't already own.
- **Parity layers** (per capability-parity rule): API route
  `apps/api/src/routes/v1/agent.ts` (or the existing subagent route file), MCP
  tool `apps/mcp/src/tools/agent.subagent.result.get.ts`, CLI command, and
  `docs/capabilities/agent.subagent.result.get.md` + `_index.md` entry.
  Verify with `pnpm check:manifest`.
- **Tool description** must steer the model: *"Fetch ONE child's full output when
  its summary is insufficient. Do not fetch all children — summaries plus
  `aggregatedData` conflicts are usually enough."* This guidance is the guard
  against the failure mode where the model re-fetches every child and recreates
  the relay cost as N tool calls.

### 3. Structural summaries at child completion

Add `summary text` column to `subagent_runs` (migration in
`packages/database/migrations/`). Populated by the executor
(`packages/inngest-functions/src/functions/agent.execute-subagent.ts`) when each
child finishes, with zero LLM calls:

1. If the child's output object has a top-level string field named `summary`,
   `message`, or `text` → take it, truncated to 280 chars.
2. Else → `JSON.stringify(output)` truncated to 280 chars.
3. On failure → `errorReason` truncated to 280 chars.

280 chars matches the proven CLI-fleet budget (`orchestrator.ts:379`). Handlers
that want better summaries add a `summary` field to their output schema — an
incremental, per-capability improvement path that needs no coordination.

### 4. Graph projection of child results (moved to Phase 2)

**Implementation note (2026-07-03):** deferred out of Phase 1. The existing
rails (`recordExecutionInGraph`, `agent.sync-execution-to-graph`) key off an
`agent_executions` Postgres row and require an `originType`/`originId` pair
mapped through `originLabelFor` — a subagent run has neither today, and
inventing an origin shape ad hoc would bake wrong ontology semantics into the
graph. Projection of child results as `:Execution` nodes (with
`properties.fanoutId`/`runId` and the §3 summary) moves to the Phase 2 spec
(`docs/specs/graph-mediated-fanout-phase2/`), where the peer-read model that
consumes it is designed. It contributes nothing
to the Phase 1 token/latency win — nothing on the hot path references it.

### 5. Fewer aggregate polls

The durable aggregator already parks on
`agent/subagent.fanout.completed` (`agent.aggregate-fanout.ts:40`) — completion
is event-driven server-side. The remaining waste is the *parent LLM* calling the
aggregate tool while the fanout is still running:

- When `status` is `pending`/`running`, the aggregate handler returns **no
  `children[]` at all** — just counts (`totalChildren`, `completedChildren`),
  `status`, and a `recheckAfterMs` hint derived from median child latency so far
  (default 15 000). A mid-flight poll becomes a ~100-token tool result instead of
  a partial relay blob.
- Update the dispatch/aggregate tool descriptions (MCP + agent surface) to say:
  dispatch, then continue other work or wait; check aggregate once, then respect
  `recheckAfterMs`.

## What changes, file by file

| Layer | File | Change |
|---|---|---|
| Contract | `packages/oxagen/src/contracts/agent.subagent.aggregate.ts` | compact `children[]`, `includeMerged`, `includeOutputs` (deprecated), caps, `recheckAfterMs` |
| Contract | `packages/oxagen/src/contracts/agent.subagent.result.get.ts` | new |
| Handler | `packages/agent/src/handlers/agent.subagent.aggregate.ts` | compact mapping, caps, pending short-circuit |
| Handler | `packages/agent/src/handlers/agent.subagent.result.get.ts` | new, `withTenantDb` |
| Runtime dispatcher | `packages/agent/src/dispatch/subagent.ts` | unchanged — `readFanout()` has no production consumers (tests only); reshaping it is churn without benefit |
| Executor | `packages/inngest-functions/src/functions/agent.execute-subagent.ts` | write `summary` on completion; enrich the durable execution record |
| Migration | `packages/database/migrations/NNNN_subagent_runs_summary.sql` | add `summary text` |
| MCP | `apps/mcp/src/tools/agent.subagent.aggregate.ts` | schema + description update |
| MCP | `apps/mcp/src/tools/agent.subagent.result.get.ts` | new |
| API | `apps/api/src/routes/v1/` (subagent route file) | new result.get route |
| CLI | `apps/cli/src/commands/` | result.get command |
| Ontology | `packages/ontology/src/mutations/record-execution.ts` | accept `fanoutId`/`runId` properties (if not already generic via `properties` bag) |
| Docs | `docs/capabilities/agent.subagent.aggregate.md`, `agent.subagent.result.get.md`, `_index.md` | update/new |
| ADR | `docs/adr/ADR-021-graph-mediated-fanout-results.md` | record decision, supersede ADR-010 aggregate model |

## Success metrics (ClickHouse, before/after)

Baseline for one week before rollout, compare one week after:

1. **Coordinator input tokens per fanout** — `token_usage.input_tokens`
   (`packages/ai/src/stream.ts:338`) summed over parent execution steps in
   conversations containing a `agent.subagent.dispatch` `tool_invocations` row,
   grouped by fanout (`tool_invocations.parent_message_id = fanoutId`).
   **Target: −80% on parent turns following an aggregate call.**
2. **Aggregate calls per fanout** — count of `tool_invocations` rows with
   `capability_name = 'agent.subagent.aggregate'` per `fanoutId`.
   **Target: ≤ 2 median** (one mid-flight check, one final).
3. **Parent step latency** — `token_usage.duration_ms` for parent steps after
   aggregate. Expect material drop from smaller prompts.
4. **Guard metric — result.get fan-back** — `tool_invocations` count of
   `agent.subagent.result.get` per fanout. If median approaches
   `totalChildren`, the model is re-fetching everything and the tool description
   needs tightening (or summaries are too weak). **Alert threshold: > 50% of
   children fetched.**
5. **Loop-driver truncation events** — if instrumented, expect
   `compactMessages`/truncation activations on fanout conversations to fall
   toward zero.

## Risks & mitigations

- **Model re-fetches all children** (recreates relay as N calls, plus per-call
  overhead — strictly worse). Mitigate: tool description steering (§2), 280-char
  summaries good enough for triage, guard metric #4.
- **Existing consumers of `children[].output`.** `includeOutputs: true` keeps
  them working (capped) through one release. Sweep call sites of
  `agentSubagentAggregate` and `readFanout()` before merging; update the chat
  surface and any workflow supervisor usage.
- **Summaries too lossy for merge-style tasks** (e.g. research swarm synthesis).
  Those callers set `includeMerged: true` or fetch the specific children they
  synthesize from. Full child content belongs in durable result storage and is
  retrieved by explicit scoped references; generic graph ingestion is not a
  fanout-result transport.
- **`aggregatedData` cap breaks a caller that depended on huge merges.** The cap
  surfaces as `aggregatedDataTruncated: true`, not silent data loss; such callers
  migrate to result.get.

## Test plan

- Unit (`packages/agent`): compact mapping, `includeOutputs`/`includeMerged`
  flags, 8 KB / 16 KB caps + truncation markers, pending short-circuit shape,
  summary derivation precedence (summary → message → text → stringify → error),
  tenancy isolation on result.get (cross-org runId → not found).
- Contract tests: schema round-trip for both contracts; `pnpm check:contracts`.
- Parity: `pnpm check:manifest` green for result.get across api/mcp/cli/docs.
- Migration: `pnpm db:lint-migrations`; post-migrate `SELECT` verifying `summary`
  column exists and is populated by a dispatched test fanout.
- E2E: one fanout via MCP — dispatch 3 children, aggregate returns summaries only,
  result.get returns one full payload, `includeOutputs: true` still works.
- Coverage: per repo ratchet rules — new handler/contract code fully tested,
  thresholds untouched or ratcheted per policy.

## Rollout

1. Migration + executor summary writes ship first (additive, inert).
2. Contract/handler/MCP/API/CLI/docs land together behind the default-flip
   (`includeOutputs` default `false` at launch — callers needing old behavior
   pass the flag; the sweep in Risks ensures first-party callers are updated in
   the same PR).
3. Watch metrics #1–#4 for one week; then remove `includeOutputs` and file the
   Phase 2 spec (peer graph reads, claim/lease work nodes, dynamic micro-agent
   scaling) informed by the observed result.get fetch patterns.

## Why this is the 90% win

Every other benefit of the full blackboard design (peer connections, self-healing
leases, dynamic scaling) changes *coordination topology* — high design risk,
many new primitives. This spec changes only *what flows over the existing
topology*: references and summaries instead of payloads. It reuses the proven
CLI-fleet summary budget, the existing Postgres result store, the existing
event-driven aggregator, and the existing graph projection rails. Token cost on
the dominant seam drops by an order of magnitude, parent turns get faster and
fewer, and nothing about scheduling, IAM, metering, or approval flows moves.
