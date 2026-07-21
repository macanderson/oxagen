# agent.role.list (`list_agent_roles`)

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low (read-only, billing-exempt)

## Intent

List the IAM roles attached to an agent's delegated principal (Agent RBAC, `docs/specs/agent-rbac/spec.md` §3.2): active (non-deleted, non-expired) `iam.principal_role_assignments` rows joined to `iam.roles`, honouring the assignment's workspace scope. A pre-RBAC agent with no delegated principal lists zero roles rather than erroring.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`), UUID, or slug — workspace-scoped. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`). |
| `roles` | `AssignmentRow[]` | Active assignments, most recent first. |
| `total` | `number` | Count of active assignments. |

`AssignmentRow`: `assignmentId` (`pra_…`), `roleId` (`rol_…`), `roleName`, `scopeKind` (`org`/`workspace`), `isSystemDefault`, `assignedAt` (ISO), `assignedBy` (user UUID or null), `expiresAt` (ISO or null), `workspaceId` (UUID or null = org-wide).

## Roles

Org Owner, Org Admin, Org Compliance, Workspace Owner, Workspace Member.

## Side effects

None — read-only (`noBillingGate`).

## Errors

| code | meaning |
|---|---|
| `invalid_input` | Missing/empty `agentId`. |
