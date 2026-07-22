# agent.role.assign

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Assign an IAM role to an agent's principal, replacing any existing assignment. Every agent already carries exactly one role from creation (`Agent Contributor` by default — see `agent.definition.create`); this contract lets a human replace that assignment with one of the three system roles (Agent Observer / Agent Contributor / Agent Operator) or, on enterprise orgs, a custom agent role.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Public agent id (`agt_…`), UUID, or slug. |
| `roleId` | `string` | Public role id (`rol_…`) to assign. |
| `workspaceId` | `string?` | Scope the assignment to one workspace; omitted = org-wide. |
| `expiresAt` | `string?` | ISO timestamp after which the assignment lapses. |

## Output

| Field | Type | Notes |
|---|---|---|
| `assignmentId` | `string` | Public assignment id (`pra_…`). |
| `agentId` | `string` | |
| `roleId` | `string` | |
| `roleName` | `string` | |
| `previousRoleId` | `string \| null` | The role replaced by this assignment, if any. |

## Roles

Org Owner, Org Admin, Workspace Owner.

## Delegation ceiling

The assigning principal cannot attach a role whose grants exceed their own effective grants: if the target role `allow`s a capability the assigner does not themselves effectively `allow`, the call is rejected. Org Owners are exempt (super-user).

## Tier gating

The three system agent roles are assignable at every org tier. CUSTOM agent roles (`isSystemDefault=false`) require an enterprise plan — the same tier check (`canAccessACL`) used for custom IAM roles elsewhere.

## Side effects

- Postgres: soft-deletes any existing `iam.principal_role_assignments` row for the agent's principal, then inserts the new assignment.
- ClickHouse: emits the standard IAM audit event (`target_kind: "agent"`, `target_id: agentId`).

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse. |
| Agent/role not found | The agent or role does not exist in this org/workspace. |
| Delegation ceiling | The target role exceeds the assigner's own effective grants. |
| Tier denied | A custom agent role was requested on a non-enterprise org. |
