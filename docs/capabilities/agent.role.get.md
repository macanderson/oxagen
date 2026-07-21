# agent.role.get (`get_agent_role`)

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low (read-only, billing-exempt)

## Intent

Inspect one IAM role relative to an agent's delegated principal (Agent RBAC, `docs/specs/agent-rbac/spec.md` §3.2): resolves the named role in the org, reports whether the agent's principal currently holds it (active, non-expired assignment), and returns the role's capability grant list so a reviewer sees exactly what attaching it confers.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`), UUID, or slug — workspace-scoped. |
| `roleName` | `string` | IAM role name to inspect. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`). |
| `roleId` | `string` | Public role id (`rol_…`). |
| `roleName` | `string` | The role's name. |
| `assigned` | `boolean` | True when the agent's principal holds an active assignment. |
| `assignment` | `AssignmentRow \| null` | The active assignment when held (see `agent.role.list`). |
| `grants` | `{ capability, effect }[]` | Capability grants the role carries (`allow`/`deny`/`require_approval`). |

## Roles

Org Owner, Org Admin, Org Compliance, Workspace Owner, Workspace Member.

## Side effects

None — read-only (`noBillingGate`).

## Errors

| code | meaning |
|---|---|
| `agent_role_not_found` | No role with that name exists in the org. |
