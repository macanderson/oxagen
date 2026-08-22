# Spec: Graph-Mediated Fleet Coordination (Phase 2 — Blackboard)

**Status:** Partially superseded — durable Postgres coordination remains; the
automatic Neo4j execution projection and semantic peer-recall slice were
retired for launch.
**Owner:** Mac Anderson
**Related:** `docs/specs/graph-mediated-fanout/` (Phase 1, shipped in #527), ADR-010 (subagent fanout via Inngest)

> **Launch boundary:** `subagent_runs` summaries, claims, leases, sibling reads,
> and telemetry remain authoritative. The historical `:Execution` projection
> and cross-fanout vector recall below are not active launch architecture.
> Exact run evidence belongs in the durable trace/evidence ledger; any future
> workspace-graph `Run` projection must be derived from that typed evidence.

## Where Phase 1 left the topology

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

## Goals

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

## Non-goals

- Peer-to-peer messaging or persistent inter-agent channels.
- Replacing Inngest as the execution substrate.
- LLM-generated summaries (Phase 1's structural digests stay).
- Changing the in-process fleet runner (already summary-based and lock-aware).

## Design

### 1. Durable claim/lease on work rows (the new primitive)

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

### 2. Graph projection of results (Phase 1 §4, now with correct semantics)

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

### 3. Peer reads — two tiers, no new query engine

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

### 4. Dynamic micro-agent scaling (policy over existing rails)

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

### 5. Termination

Unchanged in shape — last-child-finalize plus, from §1, the sweeper as the
backstop finalizer. A fanout is terminal when every child is terminal; §1's
attempt cap guarantees every child *becomes* terminal. No coordinator polling
anywhere in the loop.

## What this explicitly does NOT relitigate

- Compact-by-default aggregate, `result.get`, structural summaries (Phase 1).
- Inngest as executor; Postgres as operational truth; Neo4j as semantic index.
- The Phase 1 decision to keep `readFanout()` and the in-process fleet runner untouched.

## Delivery slices (each independently shippable, in order of value)

| Slice | Contents | New surface |
|---|---|---|
| **2a — self-healing** | §1 migration + claim UPDATE + executor claim-loop + `agent.lease-sweep` cron + lease telemetry | none (internal) |
| **2b — projection + peers** | §2 originType/label ritual + executor projection; §3 `agent.subagent.siblings` (contract→API→MCP→docs parity) + MemoryProvider peer recall | 1 capability |
| **2c — scaling policy** | §4 descendant cap + prompt-rule rollout + telemetry field | none |

2a is the 80% of Phase 2: it is the only part that changes failure semantics.
2b/2c are additive and can trail by weeks without cost.

## Success metrics (extend `pnpm metrics:fanout`)

1. **Reclaim MTTR** — `agent.task.reclaimed` minus matching `agent.lease.expired`
   event times; target ≤ 1 sweep interval (5 min).
2. **Stuck-fanout rate** — fanouts non-terminal after 2× expected duration;
   target → 0 (today: any worker death strands the fanout as `running`).
3. **Duplicate-work rate** — children executed more than once without an
   intervening lease expiry (claim correctness); target 0.
4. **Sibling-read adoption** — `agent.subagent.siblings` calls per fanout vs.
   `result.get` fan-back guard staying < 0.5 (Phase 1 metric must not regress).
5. **Depth/descendant distribution** — from `fanout.completed` payloads; alert
   on descendant-cap hits (signal the cap is doing work, or is too tight).

## Risks

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

## Test plan (per repo law)

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
