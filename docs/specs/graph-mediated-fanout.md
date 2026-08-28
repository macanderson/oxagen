---
title: "Graph-Mediated Fan-out (Phases 1 & 2)"
description: "Archived spec & plan — status: shipped (audited 2026-07-03)."
---

> **Status: Partially superseded** — compact Postgres summaries, claims, leases,
> sibling reads, and scaling remain. The automatic Neo4j execution projection
> and cross-fanout semantic peer recall were retired for launch.
>
> Phase 1 replaced full-payload relay with compact summaries and on-demand
> fetches. Phase 2's durable claim/lease self-healing, sibling capability, and
> scaling policy remain; its hidden graph projection/recall extension does not.

**Implementation evidence**

- packages/oxagen/src/contracts/agent.subagent.aggregate.ts — compact contract with summary/outputBytes/runId, deprecated includeOutputs, includeMerged with caps
- packages/oxagen/src/contracts/agent.subagent.result.get.ts — Phase 1 new contract for scoped on-demand reads (PR #527)
- packages/oxagen/src/contracts/agent.subagent.siblings.ts — Phase 2 new contract for peer snapshot (Tier A)
- packages/agent/src/handlers/agent.subagent.aggregate.ts — compact logic with pending short-circuit returning only counts + recheckAfterMs
- packages/agent/src/handlers/agent.subagent.result.get.ts — Phase 1 new handler with tenant scoping (PR #527)
- packages/agent/src/handlers/agent.subagent.siblings.ts — Phase 2 new handler with sibling query
- packages/inngest-functions/src/functions/agent.execute-subagent.ts — claim-loop pattern (Phase 2 2a) + structural summary writes (Phase 1)
- packages/inngest-functions/src/functions/agent.lease-sweep.ts — Phase 2 new cron for expired-lease reclaim and backstop finalization
- packages/database/atlas/migrations/20260703120000_subagent_runs_summary.sql — Phase 1 migration adds summary column
- packages/database/atlas/migrations/20260703150000_phase2_claim_lease.sql — Phase 2 migration adds claimed_by/lease_expires_at/attempts + claim indexes + originType fanout
- packages/agent/src/handlers/agent.subagent.dispatch.ts — descendant cap enforcement at 250 tasks (Phase 2 2c)
- apps/mcp/src/tools/agent.subagent.result.get.ts — Phase 1 MCP tool (PR #527)
- apps/mcp/src/tools/agent.subagent.siblings.ts — Phase 2 MCP tool
- apps/api/src/routes/v1/agent.subagent.result.get.ts — Phase 1 API route (PR #527)
- apps/api/src/routes/v1/agent.subagent.siblings.ts — Phase 2 API route
- docs/capabilities/agent.subagent.result.get.md — Phase 1 capability doc
- docs/capabilities/agent.subagent.siblings.md — Phase 2 capability doc
- git log main — PR #527 (Phase 1 compact aggregate + result.get) merged; PR #551 (Phase 2 self-healing + projection + peers + scaling) merged

**Source documents** (archived verbatim below)

- `docs/specs/graph-mediated-fanout/README.md`
- `docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md`
- `docs/specs/graph-mediated-fanout-phase2/README.md`

## Document — `README.md`

## Spec: Graph-Mediated Fanout Results (Blackboard-Lite)

**Status:** Draft
**Owner:** Mac Anderson
**Related:** ADR-010 (subagent fanout via Inngest), ADR-019 (unified agent engine)
**Supersedes on acceptance:** parts of ADR-010's aggregate model → file as ADR-021

### Problem — one seam burns most of the fleet's tokens and wall-clock

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

### Goals

1. **Cut coordinator input tokens per fanout by ≥ 80%** on the aggregate seam:
   the parent receives summaries + references, never full payloads by default.
2. **Reduce parent turns/latency**: fewer aggregate polls, smaller prompts per
   parent step, less loop-driver compaction work.
3. **Keep full results retrievable on demand** — a scoped read of exactly one
   child's output when the parent actually needs it.
4. **Zero LLM cost added**: summaries are structural (handler-declared or
   truncation), not model-generated.

### Non-goals (Phase 2+, separate spec)

- Peer-to-peer coordination through the graph (workers reading each other's
  results, claim/lease work nodes, desired-state reconciliation, dynamic
  micro-agent scaling). This spec builds the substrate those need — structured
  result refs + graph projection — without changing the coordination topology.
- Replacing the workflow supervisor (`agent.workflow.supervisor.ts`) planner.
- Changing the CLI fleet (already summary-based).

### Design

#### 1. Compact-by-default `agent.subagent.aggregate`

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

#### 2. New capability: `agent.subagent.result.get` (scoped on-demand read)

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

#### 3. Structural summaries at child completion

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

#### 4. Graph projection of child results (moved to Phase 2)

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

#### 5. Fewer aggregate polls

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

### What changes, file by file

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

### Success metrics (ClickHouse, before/after)

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

### Risks & mitigations

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

### Test plan

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

### Rollout

1. Migration + executor summary writes ship first (additive, inert).
2. Contract/handler/MCP/API/CLI/docs land together behind the default-flip
   (`includeOutputs` default `false` at launch — callers needing old behavior
   pass the flag; the sweep in Risks ensures first-party callers are updated in
   the same PR).
3. Watch metrics #1–#4 for one week; then remove `includeOutputs` and file the
   Phase 2 spec (peer graph reads, claim/lease work nodes, dynamic micro-agent
   scaling) informed by the observed result.get fetch patterns.

### Why this is the 90% win

Every other benefit of the full blackboard design (peer connections, self-healing
leases, dynamic scaling) changes *coordination topology* — high design risk,
many new primitives. This spec changes only *what flows over the existing
topology*: references and summaries instead of payloads. It reuses the proven
CLI-fleet summary budget, the existing Postgres result store, the existing
event-driven aggregator, and the existing graph projection rails. Token cost on
the dominant seam drops by an order of magnitude, parent turns get faster and
fewer, and nothing about scheduling, IAM, metering, or approval flows moves.

## Document — `atlas-fresh-replay-defect.md`

## Atlas fresh-replay defect: `pg_trgm` never created by any migration

**Status:** needs team decision · **Found:** 2026-07-03 (while generating the
`subagent_runs.summary` migration for PR #527) · **Blast radius:** any fresh
environment bootstrap + every local `atlas migrate diff`

> Ready to paste into Linear (`oxagen-v2`): suggested labels `database`,
> `infra`, `tech-debt` · estimate S(2) · priority P2 — filed as a doc because
> the repo `LINEAR_API_KEY` was stale (401) at time of writing.

### Problem

`packages/database/atlas/migrations/20260625130000_*.sql` creates
`catalog_servers_search_trgm_idx` using the `gin_trgm_ops` operator class, but
**no migration creates the `pg_trgm` extension**. The baseline
(`20260611233016_initial_schema.sql:2-8`) creates only `citext`, `uuid-ossp`,
and the `pg_uuidv7` fallback.

Consequences, verified locally:

1. **`atlas migrate diff` is broken for everyone** since 2026-06-25. Atlas
   replays the migration directory on the `atlas_dev` scratch DB (wiping it
   first, extensions included) and dies at `20260625130000` with
   `operator class "gin_trgm_ops" does not exist` — so recent migrations have
   been hand-written + `atlas migrate hash`, bypassing drift detection.
2. **A fresh environment cannot bootstrap.** `atlas migrate apply` on an empty
   database fails at the same version. Existing envs (local, preview, prod)
   only work because `pg_trgm` was present before that migration was applied.

Interim mitigation already merged (PR #527): `tools/scripts/atlas-dev-setup.sh`
now installs `pg_trgm` in `atlas_dev` — but Atlas's start-of-run wipe drops it
again mid-replay, so this alone does NOT restore `migrate diff`; only a
migration-resident `CREATE EXTENSION` does.

### Why this needs a decision (not a drive-by fix)

The clean fix edits an **applied** migration, and this repo's policy says
migrations are immutable after merge. More concretely: Atlas records a hash per
applied version in `atlas_schema_revisions`; `migrate apply` errors on any
already-applied file whose hash changed. An uncoordinated edit would brick
deploys on every environment simultaneously.

### Options

#### Option A — edit the offending migration + re-baseline revisions (recommended)

1. Prepend `CREATE EXTENSION IF NOT EXISTS pg_trgm;` to
   `20260625130000_widen_installed_plugins_type_check.sql` (idempotent — a
   no-op everywhere it already ran).
2. `atlas migrate hash` (updates `atlas.sum`).
3. On each env that already applied it (prod, preview, any long-lived local):
   `atlas migrate set 20260625130000 --env <env>` (or newest applied version)
   to re-baseline the revision hashes. One-time, read-only w.r.t. schema.
4. Verify: `atlas migrate status --env <env>` clean, and a scratch
   `atlas migrate apply` on an empty DB completes end-to-end.

Pros: restores both fresh bootstrap AND `migrate diff`; content change is
provably a no-op on applied envs. Cons: touches applied-migration policy;
step 3 must run on every env before its next deploy (sequence it in one PR +
one ops window).

#### Option B — new "extensions repair" migration + documented dev-DB caveat

Add `2026MMDD_create_pg_trgm.sql` (CREATE EXTENSION IF NOT EXISTS) so *future*
schema state is self-describing, and accept that replay-from-zero still fails
at `20260625130000` — fresh bootstrap would need a documented manual
`CREATE EXTENSION pg_trgm` before `migrate apply`, and `migrate diff` stays
broken (or requires a template dev-DB image with pg_trgm preinstalled, e.g.
`dev = "docker://postgres/17/dev"` swapped for a custom image).

Pros: zero applied-migration edits. Cons: `migrate diff` stays broken — the
actual day-to-day pain — and bootstrap gains a manual step that WILL be
forgotten.

#### Option C — squash to a new baseline

Re-baseline the whole directory (`atlas migrate new --baseline`-style) with
extensions correct. Largest blast radius; only worth it bundled with other
migration-hygiene work.

### Recommendation

**Option A.** The edit is a provable no-op on every applied environment, the
revision re-baseline is a supported Atlas flow, and it is the only option that
restores `migrate diff` (drift detection) — which is the tool that would have
caught this class of bug in the first place.

### Acceptance checklist

- [ ] `atlas migrate apply --env local` on an EMPTY scratch database completes 0→HEAD
- [ ] `bash tools/scripts/atlas-dev-setup.sh && atlas migrate diff --env local <name>` produces a diff (no replay error)
- [ ] `atlas migrate status` clean on prod + preview after re-baseline
- [ ] CI migration job green on the next real migration PR

### Rollback

Step 3 (`migrate set`) is metadata-only; reverting the file edit +
`atlas migrate hash` + re-running `migrate set` restores the prior state. No
schema objects are created or dropped anywhere (`IF NOT EXISTS` no-op).

## Document — `README.md`

## Spec: Graph-Mediated Fleet Coordination (Phase 2 — Blackboard)

**Status:** Implemented (slices 2a/2b/2c) — PR feat/graph-fanout-phase2
**Owner:** Mac Anderson
**Related:** `docs/specs/graph-mediated-fanout/` (Phase 1, shipped in #527), ADR-010 (subagent fanout via Inngest), ADR-019 (unified agent engine)

### Where Phase 1 left the topology

Phase 1 fixed *what flows over the wire* — summaries + refs instead of payload
relay (85% smaller aggregate responses, measured). The *coordination topology*
is unchanged, and scouting the substrate shows it is less centralized than the
original design assumed:

- **Completion detection is already decentralized.** The workflow supervisor
  (`packages/inngest-functions/src/functions/agent.workflow.supervisor.ts:39-204`)
  runs once — plan → persist → dispatch — and then exits. The **last child to
  finish** detects completion via a single aggregating count and finalizes the
  execution itself (`agent.workflow.task.execute.ts:155-205`). There is no
  supervisor loop to remove.
- **Recursive, metered decomposition already works.** Every fanout child runs
  through `kernel.invoke()` (`agent.execute-subagent.ts:148`), so a child whose
  capability calls `dispatchFanout()` produces a nested, IAM-checked, metered
  sub-fanout today — bounded by `MAX_FANOUT_DEPTH = 3` carried in the Inngest
  event payload.
- **What is actually missing is durability of *responsibility*.** There is no
  claim, lease, attempts counter, or reassignment anywhere in the agent/job
  tables — no `SELECT … FOR UPDATE SKIP LOCKED`, no `locked_until`, nothing. A
  child that dies mid-run leaves its row `running` forever; Inngest's single
  retry is the only healing. The closest precedent, the engram blackboard's
  `IntentLedger` (`packages/engram/src/blackboard/intent.ts`), has exactly the
  right semantics — claim / targets-overlap conflict / TTL auto-abandon — but
  is an **in-memory Map**: not durable, not tenant-scoped.

Phase 2 therefore has one load-bearing new primitive (durable claim/lease) and
three features that ride existing rails (graph projection, peer reads, scaling
policy). Explicitly rejected, per the Phase 1 analysis: all-to-all agent
messaging. The stores are the connection; nothing streams to an agent that
didn't ask.

### Goals

1. **Self-healing:** a dead or wedged worker's task is reclaimed and re-run
   automatically within one lease window — no coordinator, no human.
2. **Peer awareness without coordinator turns:** a running worker can read its
   siblings' compact summaries (same-fanout) and semantically recall relevant
   prior results (cross-fanout) — never full payloads by default.
3. **Bounded dynamic scaling:** a worker that judges its task too large
   decomposes it into micro-tasks via the existing nested-dispatch path, under
   explicit depth/width/attempt budgets.
4. **Termination stays data-driven:** "done" remains a predicate over rows
   (all children terminal), now robust to worker death via attempt caps.

### Non-goals

- Peer-to-peer messaging or persistent inter-agent channels.
- Replacing Inngest as the execution substrate.
- LLM-generated summaries (Phase 1's structural digests stay).
- Changing the CLI fleet (in-process, already summary-based and lock-aware).

### Design

#### 1. Durable claim/lease on work rows (the new primitive)

Add to **both** `subagent_runs` and `agent_execution_steps`
(`packages/database/src/schema/agent.ts`), via one Atlas migration:

```sql
claimed_by       text,          -- worker identity: inngest run id (background_tasks precedent)
lease_expires_at timestamptz,   -- null = unclaimed or terminal
attempts         integer NOT NULL DEFAULT 0
-- partial index: (org_id, status) WHERE status IN ('pending','running')
```

**Claim** is a single atomic UPDATE (no separate SELECT — no TOCTOU):

```sql
UPDATE agent.subagent_runs SET
  status = 'running', claimed_by = $worker, attempts = attempts + 1,
  lease_expires_at = now() + $leaseInterval, started_at = coalesce(started_at, now())
WHERE id = (
  SELECT id FROM agent.subagent_runs
  WHERE fanout_id = $fanoutId AND org_id = $orgId
    AND (status = 'pending' OR (status = 'running' AND lease_expires_at < now()))
  ORDER BY created_at LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING id, input_payload, attempts;
```

- **Lease renewal:** the executor renews (`lease_expires_at = now() + interval`)
  around each `step.run` boundary. Default lease interval **10 min** (children
  may run long LLM calls); renewal is a cheap UPDATE, not a heartbeat process.
- **Sweeper:** new Inngest cron `agent.lease-sweep` (every 5 min, per-org
  concurrency 1): expired-lease rows with `attempts < MAX_ATTEMPTS (3)` flip
  back to `pending` and re-emit `agent/subagent.dispatch` (executor's existing
  claim loop picks them up); rows at the attempt cap go `failed` with
  `error_reason = 'lease expired after N attempts'`. The sweeper then runs the
  same last-child-finalize count the task executor uses — so a fanout whose
  worker died AFTER the last child finished still terminates.
- **Executor change:** `agent.execute-subagent` stops iterating its loaded
  child list positionally and instead claim-loops (`while (row = claim())`),
  which makes N concurrent executor invocations for the same fanout safe —
  today they would double-run children; with claims they cooperatively drain
  the queue. This is what makes *fleet-level* scale-out (more executors)
  correct, not just per-child steps.
- Same treatment for `agent_execution_steps` + `agent.workflow.task.execute`
  (`mark-running` becomes a claim; a lost worker's step is resweepable). The
  supervisor keeps its plan-once role — planning was never the bottleneck;
  unowned failure was.

Telemetry: sweeper emits `events` rows `agent.lease.expired` /
`agent.task.reclaimed` `{fanoutId|executionId, runId|stepId, attempts, claimedBy}`
— the self-healing MTTR metric reads straight off these.

#### 2. Graph projection of results (Phase 1 §4, now with correct semantics)

Project each terminal child as an `:Execution` node — fire-and-forget from the
executor after the terminal write, riding `recordExecutionInGraph`:

- **originType `"fanout"`** — the four-place ritual the scout confirmed:
  1. `AGENT_EXECUTION_ORIGIN_TYPES` in
     `packages/oxagen/src/contracts/agent.execution.record.ts:11-17`;
  2. `agent_executions_origin_type_check` CHECK constraint — schema edit
     **plus migration** (this CHECK has rejected an unmigrated originType in
     prod before; comment at `schema/agent.ts:320-325`);
  3. `originLabelFor` case in
     `packages/ontology/src/mutations/record-execution.ts:205-214` returning
     the new label;
  4. New system label `NodeLabels.Fanout` in `packages/ontology/src/types.ts`
     + `schema.cypher` publicId constraint + orgId index (system-label ritual).
- Node payload: Phase 1's structural `summary` (embedding source), and
  `properties.fanoutId` / `runId` / `capabilityName` / `attempts`. Edges:
  `[:ORIGINATED_FROM]->(:Fanout)`, existing `[:INVOKED]`/`[:CALLED_TOOL]`.
- **Embedding computed by the caller** (executor) via `@oxagen/ai` — the
  ontology package must not depend on it (`RecordExecutionInput.embedding`
  contract). Batch: one embedding call per child completion, same text as the
  280-char summary — bounded cost by construction.

Postgres stays the operational record; the graph is the semantic index over
results — consistent with the four-store law and the connector dual-write
precedent.

#### 3. Peer reads — two tiers, no new query engine

**Tier A — sibling snapshot (hot path, Postgres, compact).** New capability
`agent.subagent.siblings` `{runId}` → the calling child's fanout siblings as
`{runId, capabilityName, status, summary, attempts}` — the Phase 1 compact
shape, never payloads (a sibling's full output is a `result.get` away, same
steering rule). Available on the agent surface so a running child can check
"has a sibling already covered X?" before burning tokens. One indexed query;
no graph round-trip on the hot path.

**Tier B — semantic peer recall (cross-fanout, graph, rides memory).** Extend
the platform `MemoryProvider.recallContext()`
(`packages/agent/src/adapters/memory-provider.ts:41-96`) to also embed-search
`:Execution` summaries (label filter added to the existing `recallMemories`
Cypher, threshold 0.7, limit 4) and append hits as
`- [peer-result] <summary> (run <runId>)` lines to the returned string. The
injection point is untouched — the engine already inserts recall as a
dedicated non-cached system message (`packages/agent-engine/src/engine.ts:91-127`),
so every agent surface wired for memory gets peer recall for free, and the
prompt-cache rules from the memory-wiring work still hold.

Traversal-style peer queries (e.g. "everything this fanout touched") reuse the
existing templated-Cypher pattern from `ontology.query` — tenant predicates on
every node, two-layer edge-type allow-listing, no caller-supplied Cypher.

#### 4. Dynamic micro-agent scaling (policy over existing rails)

Mechanism exists; Phase 2 adds the policy and the budgets:

- **Decomposition rule (in the child agent's system prompt, not new code):** a
  worker that cannot finish inside its budget dispatches
  `agent.subagent.dispatch` with micro-tasks and returns a summary pointing at
  the child fanout (`{delegatedFanoutId}`) instead of grinding or failing.
- **Budgets, all enforced where they already live:** depth stays
  `MAX_FANOUT_DEPTH = 3` (event-payload-threaded); width stays the dispatch
  contract's 100-task cap; **new:** per-org *total descendant* cap for a root
  fanout (default 250), enforced at dispatch time by walking
  `parent_message_id` lineage — prevents 3-deep × 100-wide = 10⁶ explosions
  that per-level caps allow.
- Attempts from §1 apply at every level — a decomposed micro-task that keeps
  dying is capped identically.
- Depth is already in the completion telemetry payload; add
  `descendantCount` to `agent.subagent.fanout.completed` for the scaling
  metrics.

#### 5. Termination

Unchanged in shape — last-child-finalize plus, from §1, the sweeper as the
backstop finalizer. A fanout is terminal when every child is terminal; §1's
attempt cap guarantees every child *becomes* terminal. No coordinator polling
anywhere in the loop.

### What this explicitly does NOT relitigate

- Compact-by-default aggregate, `result.get`, structural summaries (Phase 1).
- Inngest as executor; Postgres as operational truth; Neo4j as semantic index.
- The Phase 1 decision to keep `readFanout()` and the CLI fleet untouched.

### Delivery slices (each independently shippable, in order of value)

| Slice | Contents | New surface |
|---|---|---|
| **2a — self-healing** | §1 migration + claim UPDATE + executor claim-loop + `agent.lease-sweep` cron + lease telemetry | none (internal) |
| **2b — projection + peers** | §2 originType/label ritual + executor projection; §3 `agent.subagent.siblings` (contract→API→MCP→docs parity) + MemoryProvider peer recall | 1 capability |
| **2c — scaling policy** | §4 descendant cap + prompt-rule rollout + telemetry field | none |

2a is the 80% of Phase 2: it is the only part that changes failure semantics.
2b/2c are additive and can trail by weeks without cost.

### Success metrics (extend `pnpm metrics:fanout`)

1. **Reclaim MTTR** — `agent.task.reclaimed` minus matching `agent.lease.expired`
   event times; target ≤ 1 sweep interval (5 min).
2. **Stuck-fanout rate** — fanouts non-terminal after 2× expected duration;
   target → 0 (today: any worker death strands the fanout as `running`).
3. **Duplicate-work rate** — children executed more than once without an
   intervening lease expiry (claim correctness); target 0.
4. **Sibling-read adoption** — `agent.subagent.siblings` calls per fanout vs.
   `result.get` fan-back guard staying \< 0.5 (Phase 1 metric must not regress).
5. **Depth/descendant distribution** — from `fanout.completed` payloads; alert
   on descendant-cap hits (signal the cap is doing work, or is too tight).

### Risks

- **Lease interval vs. long LLM calls:** a 10-min lease with renewal at step
  boundaries can still expire inside one very long `invoke()`. Mitigation:
  renewal wrapper around the invoke with a timer, and MAX_ATTEMPTS makes a
  false reclaim converge (idempotency: children are capability invocations;
  side-effecting capabilities already carry riskLevel/approval semantics).
- **Graph projection cost:** one embedding + one MERGE per child. Bounded by
  summary length; fire-and-forget with the same retry envelope as
  `agent.sync-execution-to-graph` (17 retries / ~24 h).
- **Peer recall polluting prompts:** capped at 4 lines, threshold 0.7, and the
  non-cached-system-message injection point means no prompt-cache invalidation.
- **Sibling snapshot races:** a sibling's summary may be seconds stale — fine;
  it steers work avoidance, it is not a consistency primitive.

### Test plan (per repo law)

- Claim UPDATE: unit tests with two concurrent claimers on one pending row
  (integration-style against local Postgres — SKIP LOCKED semantics can't be
  mocked meaningfully); attempts cap → failed; expired-lease reclaim.
- Sweeper: pure-helper extraction for the requeue/finalize decision + Inngest
  fn test in the existing style (`agent.aggregate-fanout.test.ts` pattern).
- `agent.subagent.siblings`: handler tenancy test (cross-tenant runId → 404),
  contract round-trip, MCP registry parity — the Phase 1 result.get test suite
  is the template.
- originType `"fanout"`: contract enum test + migration SELECT verification +
  `originLabelFor` unit case.
- Peer recall: memory-provider test asserting `[peer-result]` lines appear and
  the recall string stays ≤ the existing budget.
