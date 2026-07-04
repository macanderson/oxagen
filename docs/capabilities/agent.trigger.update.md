# agent.trigger.update

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Update an existing agent trigger in place. Replaces its type-specific binding and enabled flag, re-validated against `agentTriggerSchema`.

## Input

| Field | Type | Notes |
|---|---|---|
| `triggerId` | `string` | Trigger public id (`atr_…`) or UUID. |
| `trigger` | `AgentTrigger` | The replacement binding — see fields below. |
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
| `triggerId` | `string` | Echoes the target trigger id. |
| `triggerType` | `"manual" \| "schedule" \| "event"` | The resulting trigger kind. |
| `enabled` | `boolean` | Whether the trigger is enabled. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Postgres: updates the `agent_triggers` row's type-specific binding and enabled flag.
- ClickHouse: emits an `agent.trigger.updated` audit/telemetry event.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. event trigger missing source/type, schedule missing cron). |
| `not_found` | No trigger matches `triggerId` in this workspace. |
| `unauthorized` | Caller lacks the required org/workspace role. |
