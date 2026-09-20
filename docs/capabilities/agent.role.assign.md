# assign_agent_role

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high (requires approval on the agent surface)

## Intent

Attach an IAM role to an agent's delegated principal (Agent RBAC, `docs/specs/agent-rbac/spec.md` §3.2). Writes `iam.principal_role_assignments` for the agent's own `iam.principals` row. Roles are resolved **by name** so seeding (`pnpm db:seed-iam`) and assignment stay decoupled.

Governance rules:

- Among system roles, only the agent system roles (`Agent Observer`, `Agent Contributor`, `Agent Operator`) are agent-assignable — human org roles (Owner, Admin, …) never are. These three are the complete set: they are assignable at every org tier, whereas any other role is a custom role gated to enterprise. The spec's back-compat `Agent Legacy (unrestricted)` role does not exist in this build — spec §6 Q1 resolved that this is a pre-launch product with no customers, so no back-compat role is seeded and none is accepted here.
- New agents are auto-assigned `Agent Contributor` on `agent.definition.create`; the builder (and any AI-assisted setup flow) narrows or widens from there through this capability. See the user-facing [Agent roles](../../apps/docs/content/docs/governance/agent-roles.mdx) page for what each role means.
- **No tier gate (ADR-069):** system agent roles and custom roles are both assignable at every org tier. What the tier decides is whether the kernel resolves a grant, which `list_iam_roles` reports as `enforcement`; it does not decide whether a role may exist or be held. A role bound below the enterprise tier governs nothing until the org moves to one, and the app says so where it offers the assignment.
- **Delegation ceiling:** the assigning user cannot attach a role whose grants exceed their own effective grants — each capability the role confers is resolved for the assigner through the pure IAM resolver; a role conferring a less restrictive outcome than the assigner's own is rejected.

Re-assignment after a revoke resurrects the soft-deleted assignment row; an already-active assignment returns `alreadyAssigned: true` without writing.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`), UUID, or slug — workspace-scoped. |
| `roleName` | `string` | IAM role name (e.g. `"Agent Contributor"` or a custom role name). |

## Output

| Field | Type | Notes |
|---|---|---|
| `assigned` | `boolean` | True when the role is now attached. |
| `alreadyAssigned` | `boolean` | True when the agent already held an active assignment. |
| `agentId` | `string` | Agent public id (`agt_…`). |
| `roleId` | `string` | Public role id (`rol_…`). |
| `roleName` | `string` | The assigned role's name. |

## Roles

Org Owner, Org Admin — checked by the handler (`assertOrgRole`, INV-29), the gate `create_role` and `set_role_grants` run, for the acting user: the signed-in user, or the creator of the API key (`resolveActingUserId`), who is the assigner the delegation ceiling reads. A key with no creator, and a call with neither, is refused `forbidden` / `no_principal`; any other role is refused `forbidden` / `org_role_required` (2026-09-15, maintainer decision).

## Side effects

- Postgres: inserts (or resurrects) an `iam.principal_role_assignments` row for the agent's principal.
- ClickHouse: emits the IAM audit event with `principal_kind='agent'` and the agent as the audit target.

## App

`/{org}/{ws}/agents/{agent}?tab=identity` — Assign a role on the Roles panel (`apps/app/src/features/agents/identity.tsx`, `role-controls.tsx`, `actions.ts`). The picker offers `list_iam_roles` rows of `kind: "agent"` alone, so it cannot name a role this capability would refuse, and it says when the org's tier does not enforce the assignment yet.

## Errors

| code | meaning |
|---|---|
| `agent_role_not_found` | No role with that name exists in the org. |
| `agent_role_not_assignable` | The role is a non-agent system role (e.g. Owner). |
| `agent_role_ceiling_exceeded` | The role's grants exceed the assigner's own effective grants. |
| `agent_principal_missing` | The agent predates Agent RBAC principal provisioning. |
