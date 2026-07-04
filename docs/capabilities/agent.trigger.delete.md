# agent.trigger.delete

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Soft-delete an agent trigger. Marks `deletedAt` so the binding stops firing while preserving the audit record.

## Input

| Field | Type | Notes |
|---|---|---|
| `triggerId` | `string` | Trigger public id (`atr_…`) or UUID. |

## Output

| Field | Type | Notes |
|---|---|---|
| `triggerId` | `string` | Echoes the target trigger id. |
| `deleted` | `boolean` | `true` once the trigger is soft-deleted. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Postgres: sets `deletedAt` on the `agent_triggers` row (soft delete; row retained for audit).
- ClickHouse: emits an `agent.trigger.deleted` audit/telemetry event.

## Errors

| code | meaning |
|---|---|
| `not_found` | No trigger matches `triggerId` in this workspace. |
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
