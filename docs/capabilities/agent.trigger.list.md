# agent.trigger.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List the non-deleted triggers configured for an agent in the current workspace.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`) or UUID. |

## Output

| Field | Type | Notes |
|---|---|---|
| `triggers` | `TriggerRow[]` | The agent's triggers — see fields below. |
| `triggers[].triggerId` | `string` | Internal UUID. |
| `triggers[].publicId` | `string` | Prefixed public identifier (`atr_…`). |
| `triggers[].triggerType` | `"manual" \| "schedule" \| "event"` | Trigger kind. |
| `triggers[].eventSource` | `string \| null` | Source system for an event trigger, or null. |
| `triggers[].eventType` | `string \| null` | Event type within the source, or null. |
| `triggers[].connectionId` | `string \| null` | Bound connection id, or null. |
| `triggers[].filter` | `Record<string, unknown>` | Match conditions for the trigger. |
| `triggers[].schedule` | `string \| null` | Cron expression, or null. |
| `triggers[].enabled` | `boolean` | Whether the trigger is enabled. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- None — read-only. Postgres SELECT of non-deleted `agent_triggers` rows.

## Errors

| code | meaning |
|---|---|
| `not_found` | No agent matches `agentId` in this workspace. |
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
