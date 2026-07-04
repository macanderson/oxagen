# agent.deploy

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Set an agent's deployment posture. Activating requires a published active version — otherwise a typed error is returned. Deactivating is always allowed and makes the agent's triggers dormant.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`) or UUID. |
| `deploymentStatus` | `"inactive" \| "active"` | Target deployment posture. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Echoes the target agent id. |
| `deploymentStatus` | `"inactive" \| "active"` | The resulting deployment posture. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Postgres: updates the `agents` row `deploymentStatus`; activation makes bound triggers live, deactivation makes them dormant.
- ClickHouse: emits an `agent.deploy` audit/telemetry event.

## Errors

| code | meaning |
|---|---|
| `no_published_version` | Activation requested but the agent has no published active version. |
| `not_found` | No agent matches `agentId` in this workspace. |
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
