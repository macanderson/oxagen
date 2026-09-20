# revoke_agent_role

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

Org Owner, Org Admin — checked by the handler (`assertOrgRole`, INV-29), the gate `create_role` and `set_role_grants` run, for the acting user: the signed-in user, or the creator of the API key (`resolveActingUserId`), who is recorded as the revoker. A key with no creator, and a call with neither, is refused `forbidden` / `no_principal`; any other role is refused `forbidden` / `org_role_required` (2026-09-15, maintainer decision).

## Side effects

- Postgres: soft-deletes the matching `iam.principal_role_assignments` row.
- ClickHouse: emits the IAM audit event with `principal_kind='agent'` and the agent as the audit target (only when something was revoked).

## App

`/{org}/{ws}/agents/{agent}?tab=identity` — Revoke on each row of the Roles panel (`apps/app/src/features/agents/identity.tsx`, `role-controls.tsx`, `actions.ts`), behind a dialog that names the role it detaches.

## Errors

| code | meaning |
|---|---|
| `agent_role_not_found` | No role with that name exists in the org. |
| `agent_principal_missing` | The agent predates Agent RBAC principal provisioning. |
