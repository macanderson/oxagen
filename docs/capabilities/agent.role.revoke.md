# agent.role.revoke (`revoke_agent_role`)

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high (requires approval on the agent surface)

## Intent

Detach an IAM role from an agent's delegated principal (Agent RBAC, `docs/specs/agent-rbac/spec.md` §3.2). Soft-deletes the active `iam.principal_role_assignments` row so the audit trail keeps the historical assignment; `agent.role.assign` resurrects it on re-assign. Revocation is pure narrowing, so it carries no tier gate and no delegation-ceiling check.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`), UUID, or slug — workspace-scoped. |
| `roleName` | `string` | IAM role name to detach. |

## Output

| Field | Type | Notes |
|---|---|---|
| `revoked` | `boolean` | True when an active assignment was revoked; false when none existed (idempotent). |
| `agentId` | `string` | Agent public id (`agt_…`). |
| `roleName` | `string` | The role name. |

## Roles

Org Owner, Org Admin, Workspace Owner.

## Side effects

- Postgres: soft-deletes the matching `iam.principal_role_assignments` row.
- ClickHouse: emits the IAM audit event with `principal_kind='agent'` and the agent as the audit target (only when something was revoked).

## Errors

| code | meaning |
|---|---|
| `agent_role_not_found` | No role with that name exists in the org. |
| `agent_principal_missing` | The agent predates Agent RBAC principal provisioning. |
