# agent.role.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List an agent's active (non-revoked, non-expired) role assignments — the human-readable face of "what can this agent do".

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Public agent id (`agt_…`), UUID, or slug. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | |
| `assignments` | `array` | Each row: `assignmentId`, `roleId`, `roleName`, `isSystemDefault`, `workspaceId`, `assignedAt`, `expiresAt`. |

## Roles

Org Owner, Org Admin, Org Compliance, Workspace Owner, Workspace Member.

## Side effects

None — read-only.

## Errors

| code | meaning |
|---|---|
| Agent not found | The agent does not exist in this workspace. |
