# deploy_agent

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Set an agent's stored deployment posture. Activating requires a published active version. This handler updates the registry record. It does not start an agent process or schedule triggers.

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

- Postgres: updates the `agents` row `deploymentStatus` and `updatedById`.
- ClickHouse: emits an `agent.deploy` audit/telemetry event.

## Errors

| code | meaning |
|---|---|
| `agent_deploy_requires_published_version` | Activation requested but the agent has no published active version. |
| `not_found` | No agent matches `agentId` in this workspace. |
| `conflict` | The agent is retired (`agent_retired`). The handler refuses both `active` and `inactive`, since `retire_agent` already set the agent inactive. |
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
