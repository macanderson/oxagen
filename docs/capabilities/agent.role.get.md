# agent.role.get

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read one role assignment for an agent by `(agentId, roleId)`. Returns `assignment: null` (never a 404 throw) when the agent does not hold that role — "does this agent have this role" is a legitimate negative answer, not an error.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Public agent id (`agt_…`), UUID, or slug. |
| `roleId` | `string` | Public role id (`rol_…`). |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | |
| `assignment` | `object \| null` | `assignmentId`, `roleId`, `roleName`, `isSystemDefault`, `workspaceId`, `assignedAt`, `expiresAt`. |

## Roles

Org Owner, Org Admin, Org Compliance, Workspace Owner, Workspace Member.

## Side effects

None — read-only.

## Errors

| code | meaning |
|---|---|
| Agent not found | The agent does not exist in this workspace. |
