# A2A Agent Identity, Lineage & Live Subscription — Design Specification

Linear: [OXA-2063](https://linear.app/oxagen/issue/OXA-2063/a2a-agent-identity-lineage-and-live-subscription)
(sub-issues OXA-2064–OXA-2069). Branch `feat/a2a-agent-identity-lineage`.

## 1. Scope

PR #572 shipped a working A2A (Agent2Agent) v1.0 JSON-RPC transport
(`.well-known/agent-card.json` discovery + `POST /a2a`), but it is a single
anonymous endpoint bolted onto the generic chat execution path. An audit run
2026-07-04 found four concrete gaps that block A2A from being a real
per-agent interop surface:

1. **No per-agent addressing.** The discovery card enumerates each
   workspace's distinct `agents` rows as A2A "skills" (`packages/agent/src/
   handlers/a2a.card.get.ts:60-69`), but nothing on the execution side reads
   that back — every `message/send`/`message/stream` call runs the same
   generic `chatSystemPrompt`, regardless of which skill/agent the caller
   named.
2. **No lineage.** `agent_executions` (`packages/database/src/schema/
   agent.ts:294-324`) already carries `agentId`, `agentVersionId`,
   `originType`/`originId`, and a self-referencing `parentExecutionId`
   explicitly commented *"self-reference for subagent/A2A lineage"*
   (line 316-317) — but `originType`'s CHECK constraint has no `'a2a'`
   value, and `apps/api/src/routes/a2a/bridge.ts` never inserts a row into
   this table at all. A2A tasks are invisible to `agent.trace.get` /
   `agent.execution.list`.
3. **No lease/responsibility tie-in.** The subagent fan-out claim/lease
   pattern (`subagent_runs.claimedBy`/`leaseExpiresAt`,
   `packages/database/src/schema/agent.ts:272-277`) has no relationship to
   an A2A task — an agent leased into a fan-out has no way to know it is
   also fulfilling (or was spawned by) an A2A conversation.
4. **No live subscription.** `tasks/resubscribe` — the A2A method whose
   entire purpose is reattaching to an in-flight task's event stream — is
   implemented as one status snapshot followed by `controller.close()`
   (`apps/api/src/routes/a2a/rpc.ts:220-258`). Internal fan-out
   (`agent.subagent.aggregate`) is poll-only. Nothing in Oxagen lets one
   agent genuinely subscribe to another's ongoing work.
5. **No agent awareness.** No skill file and neither live system-prompt
   builder (`packages/ai/src/prompts/registry.ts` for chat/A2A,
   `packages/agent-engine/src/prompt/system-prompt.ts` for the engine loop)
   mentions the A2A protocol, external agent addressing, or subscribing to
   another agent's work.

This epic closes all five gaps. Out of scope: a marketplace/UI for
configuring per-agent A2A visibility (existing `agent.definition.*` CRUD
already controls `status`/`deploymentStatus`, which gates card visibility —
no new UI); cross-instance/durable pub-sub for resubscribe (see §3.4 — this
ships an honest, documented same-instance implementation and files the
durable follow-up separately rather than silently gap-filling).

## 2. Goals and Acceptance Criteria

The epic is complete when **all** of the following are true:

1. An A2A caller can address a specific workspace agent by putting that
   agent's slug in `message.metadata.skillId` on `message/send` or
   `message/stream`. The task executes with that agent's `instructions`
   (from its active `agent_versions.config`) layered over the chat
   baseline, not the generic prompt. Omitting `skillId` (or naming an
   inactive/undeployed agent) falls back to the existing generic behavior
   — this is additive, not breaking.
2. Every A2A task produces exactly one `agent_executions` row
   (`originType: 'a2a'`, `originId: a2aTasks.id`, `agentId` set when a
   skill was addressed, null otherwise) with `startedAt`/`completedAt`/
   `status` kept in sync with the task's own lifecycle.
3. When an incoming `message.referenceTaskIds` names a prior task, the new
   execution's `parentExecutionId` is set to that prior task's execution
   row, so `agent.trace.get` renders full A2A conversation chains exactly
   like it renders subagent fan-out chains today.
4. `a2a_tasks` gains a nullable `agentId` (routing input — which agent this
   task is addressed to) and a nullable `fanoutRunId` (set when the task
   was created from inside a `subagent_runs` execution, so a leased
   subagent run can point at the A2A task it opened, and vice versa via a
   join).
5. `tasks/resubscribe` on a non-terminal task reattaches to that task's
   live event stream (same-instance) and receives real-time
   `status-update`/`artifact-update` events until terminal, instead of one
   snapshot. On a terminal task it still returns the one final snapshot
   (correct A2A behavior — nothing to subscribe to).
6. Both live system-prompt builders (chat/A2A shared registry, the
   agent-engine loop) mention: A2A exists, how to address another agent's
   skill via `skillId`, that `tasks/resubscribe` can live-attach to a
   non-terminal task, and that internal fan-out lineage now covers A2A
   origins.
7. `pnpm check:manifest` parity holds (`a2a.card.get` unaffected;
   `agent_executions`/`a2a_tasks` are schema, not new capabilities — no new
   manifest entries required). Full gate green.

## 3. Architectural Decisions

| Concern | Choice |
| --- | --- |
| Skill addressing wire shape | `message.metadata.skillId: string` (reserved key on the existing generic `metadata` bag in `protocol.ts` — zero wire-format break for A2A clients unaware of it) |
| Per-agent prompt source | `agent_versions.config.instructions` (already the free-text field `agent.definition.create` persists) layered over `chatSystemPrompt` via the existing `resolvePrompt` composition, not a second prompt system |
| Lineage table | Reuse `agent_executions` (already designed for this — §1.2). No new table. |
| `originType` values | Add `'a2a'` to the existing CHECK constraint; no new enum/table |
| A2A ↔ fan-out link | `a2a_tasks.fanoutRunId → subagent_runs.id`, app-enforced (no cross-table FK per CLAUDE.md storage rules — same pattern already used for `agentTriggers.connectionId`) |
| Resubscribe transport | In-process `EventEmitter` registry keyed by task id, populated by the same `onEvent` callback `message/stream` already uses (`bridge.ts`) |
| Resubscribe scope (honest limitation) | Same-instance only. Vercel Fluid Compute reuses instances across concurrent requests, so this covers the common case (a client resubscribing shortly after `message/send` on a still-warm instance). Cross-instance durable resubscribe needs a shared pub-sub (e.g. Postgres `LISTEN/NOTIFY` or a queue) — tracked as an explicit follow-up ticket (§7), not silently degraded. |
| Skill/prompt content | Extend the two existing prompt sources in place; no third prompt builder |

### 3.1 Skill-addressed routing

`bridge.ts`'s `runA2ATask` currently always calls `streamAgentReply` with
`system: resolvePrompt({ key: "chat.system", baseline: chatSystemPrompt(...),
config: promptConfig })`. It gains one resolution step before that call:

```ts
const skillId = message.metadata?.skillId;
const agent = skillId ? await resolveAgentForA2A(ctx, skillId) : null;
// resolveAgentForA2A: workspace-scoped lookup by slug, requires
// status='active' AND deploymentStatus='active' (same gate a2a.card.get
// uses to decide whether to list the skill at all) — an inactive agent
// named by a stale skillId falls back to generic, it never 500s.
const baseline = agent
  ? `${chatSystemPrompt(...)}\n\n${agent.activeVersion.config.instructions ?? ""}`
  : chatSystemPrompt(...);
```

`resolveAgentForA2A` lives in `packages/agent/src/handlers/_agent-definition.ts`
next to the existing `resolveAgent` helper — same workspace-scoping
guarantee, reused rather than duplicated.

### 3.2 Lineage

`bridge.ts` inserts one `agent_executions` row when a task transitions into
`working` for the first time (mirroring how `agent.subagent.dispatch`
creates its row at fan-out time), and updates `status`/`completedAt`/
`outputPayload` when the task reaches a terminal state. `parentExecutionId`
resolution: if `message.referenceTaskIds[0]` is set, look up that task's
`agent_executions` row (join on `originType='a2a' AND originId=<taskId>`)
and use its id.

### 3.3 Fan-out tie-in

`a2a_tasks.fanoutRunId` is populated only when `runA2ATask` is invoked from
inside a subagent execution context (i.e., a subagent's own capability
invocation opens an A2A conversation with another agent) — `ctx` already
carries the current `subagent_runs.id` in that case via the existing
fan-out dispatch context. When absent (the normal external-caller path),
the column stays null. This gives a leased subagent run a way to see "I
also opened/received this A2A task" without inventing a second lease
concept — the lease itself stays exactly where it is today
(`subagent_runs.claimedBy`/`leaseExpiresAt`).

### 3.4 Live resubscribe

A module-level `Map<taskId, Set<(event) => void>>` in `apps/api/src/routes/
a2a/stream-registry.ts`. `message/stream`'s existing `onEvent` callback
publishes into the registry (in addition to writing straight to its own
SSE connection, unchanged). `tasks/resubscribe`:

1. Loads the task row (existing behavior).
2. If `A2A_TERMINAL_STATES.has(task.state)`: emits the one final snapshot,
   closes — unchanged, this is correct A2A behavior for a finished task.
3. Otherwise: emits the current snapshot as `status-update` (so a client
   that just connected isn't blind to already-elapsed progress), then
   registers a listener on the registry for that task id, forwarding every
   subsequent event verbatim until a terminal `status-update` arrives, then
   closes. Listener is removed in a `finally` on stream close/abort, so a
   dropped client fully unregisters — no leak.

## 4. Schema Additions

Postgres migration (`packages/database/atlas/migrations/`):

- `agent.agent_executions.origin_type` CHECK: add `'a2a'` to the existing
  `('chat', 'event_trigger', 'scheduled_job', 'mcp_request', 'workflow_run',
  'fanout')` list.
- `agent.a2a_tasks` gains:
  - `agent_id uuid NULL` (app-enforced ref to `agent.agents.id`) —
    which agent this task is/was addressed to.
  - `fanout_run_id uuid NULL` (app-enforced ref to `agent.subagent_runs.id`)
    — set only when opened from inside a leased subagent run.
  - Index: `a2a_tasks_agent_idx` on `(org_id, workspace_id, agent_id)` for
    "list this agent's A2A tasks" queries (paginated, per performance
    conventions — no unbounded scan).

No Neo4j or ClickHouse changes — this is transactional lineage/routing
state, which belongs in Postgres per the infrastructure boundaries in
CLAUDE.md.

## 5. Files Touched

- `packages/database/src/schema/agent.ts` — `agentId`/`fanoutRunId` columns,
  index, updated CHECK constraint.
- `packages/database/atlas/migrations/<timestamp>_a2a_agent_identity.sql` +
  regenerated `atlas.sum`.
- `apps/api/src/routes/a2a/protocol.ts` — no wire-shape change (metadata is
  already `z.record(z.string(), z.unknown())`); add a typed helper
  `getSkillId(message): string | undefined` instead of ad hoc reads.
- `apps/api/src/routes/a2a/bridge.ts` — skill resolution, `agent_executions`
  row lifecycle, `fanoutRunId` propagation, registry publish on every event.
- `apps/api/src/routes/a2a/rpc.ts` — `tasks/resubscribe` live-attach branch.
- `apps/api/src/routes/a2a/stream-registry.ts` — new, in-process event
  registry (§3.4).
- `packages/agent/src/handlers/_agent-definition.ts` —
  `resolveAgentForA2A` helper.
- `packages/ai/src/prompts/registry.ts` — A2A awareness section.
- `packages/agent-engine/src/prompt/system-prompt.ts` — A2A awareness
  section.
- `docs/capabilities/a2a.card.get.md` — note the skill-addressing contract.

## 6. Acceptance Tests

Unit (Vitest, colocated per domain):

1. `bridge.test.ts` — skill resolution: active agent → composed prompt;
   inactive/unknown `skillId` → generic fallback, no throw.
2. `bridge.test.ts` — `agent_executions` row created on first `working`
   transition, updated on terminal transition, `parentExecutionId` set from
   `referenceTaskIds`.
3. `rpc.test.ts` — `tasks/resubscribe` on a `working` task receives events
   published after the resubscribe call; on a terminal task receives
   exactly one event then the stream closes.
4. `stream-registry.test.ts` — publish before any subscriber is a no-op
   (no throw); unregister on `finally` actually removes the listener
   (assert `Map` no longer holds an empty `Set` after close, avoiding a
   slow leak across many short-lived tasks).

E2E (Playwright, `apps/app/e2e/`):

1. Full round trip: `message/send` naming a real deployed agent's
   `skillId`, assert the reply reflects that agent's `instructions`
   (distinguishable from the generic baseline in the test fixture);
   `agent.trace.get` (or equivalent UI) shows the resulting execution with
   `originType: 'a2a'`.

## 7. Out of Scope / Follow-ups

- Cross-instance durable resubscribe (Postgres `LISTEN/NOTIFY` or a queue)
  — separate ticket once the same-instance version proves the UX is worth
  the added infra.
- `tasks/pushNotificationConfig/*` (still `pushNotificationNotSupported` by
  design — unrelated to this epic).
- A UI surface for browsing A2A-originated executions distinct from the
  existing trace view — the existing `agent.trace.get`/Activity span-tree
  UI (PR #574) already renders any `originType`, so no new UI is required
  for this epic to be complete.
