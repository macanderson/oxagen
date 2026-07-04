# agent.trigger.create

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Create a trigger for an agent — a manual, scheduled (cron), or event binding. The trigger is validated against `agentTriggerSchema` (event triggers require an event source and type; schedule triggers require a cron expression) and persisted as an `agent_triggers` row.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`) or UUID. |
| `trigger` | `AgentTrigger` | The binding — see fields below. |
| `trigger.type` | `"manual" \| "schedule" \| "event"` | Kind of trigger. |
| `trigger.eventSource` | `string?` | Source system for an event trigger (e.g. `github_repo`). |
| `trigger.eventType` | `string?` | Event type within the source (e.g. `push`). |
| `trigger.connectionId` | `string?` | Connection this trigger binds to. |
| `trigger.filter` | `AgentEventFilter?` | Match conditions (branches, path globs, conditions). |
| `trigger.schedule` | `string?` | Cron expression for a schedule trigger. |
| `trigger.enabled` | `boolean` | Whether the trigger is enabled. Default `false`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `triggerId` | `string` | Internal UUID of the created trigger. |
| `publicId` | `string` | Prefixed public identifier (`atr_…`). |
| `triggerType` | `"manual" \| "schedule" \| "event"` | The trigger kind. |
| `enabled` | `boolean` | Whether the trigger is enabled. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Postgres: inserts an `agent_triggers` row bound to the agent.
- ClickHouse: emits an `agent.trigger.created` audit/telemetry event.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. event trigger missing source/type, schedule missing cron). |
| `not_found` | No agent matches `agentId` in this workspace. |
| `unauthorized` | Caller lacks the required org/workspace role. |
