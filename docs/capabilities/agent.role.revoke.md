# agent.role.revoke

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Revoke (soft-delete) an agent's role assignment. Every agent must always carry exactly one role (docs/specs/agent-rbac/spec.md §3.2) — use this immediately alongside `agent.role.assign` granting a replacement, or when an agent is being archived. Revoking without a replacement leaves the agent with no grant to match, which resolves to the contract's `defaultEffect` (fail-closed for most capabilities) rather than an "unassigned" special case.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Public agent id (`agt_…`), UUID, or slug. |
| `roleId` | `string` | Public role id (`rol_…`) to revoke. |

## Output

| Field | Type | Notes |
|---|---|---|
| `revoked` | `boolean` | `true` if a live assignment was found and revoked. |
| `agentId` | `string` | |
| `roleId` | `string` | |

## Roles

Org Owner, Org Admin, Workspace Owner.

## Side effects

- Postgres: soft-deletes the matching `iam.principal_role_assignments` row.
- ClickHouse: emits the standard IAM audit event (`target_kind: "agent"`, `target_id: agentId`).

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse. |
| Agent/role not found | The agent or role does not exist in this org. |
