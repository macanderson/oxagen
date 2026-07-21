# agent.definition.delete

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high

## Intent

Soft-delete an agent definition AND its delegated IAM principal together (Agent RBAC Phase 1, `docs/specs/agent-rbac/spec.md` §2.1). An agent identity and its principal share one lifecycle: deleting the agent never leaves an orphaned "live" principal a since-deleted agent could still be attributed through.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`) or UUID. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Echoes the target agent id. |
| `deleted` | `boolean` | `true` once the agent (and its principal) are soft-deleted. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Postgres: sets `deletedAt`/`deletedByUserId` on the `agent.agents` row (soft delete; row retained for audit).
- Postgres: sets `status='deleted'` on the agent's delegated `iam.principals` row (same tx).
- Managed (product built-in) agents cannot be deleted — throws `AgentManagedReadOnlyError`.

## Errors

| code | meaning |
|---|---|
| `not_found` | No agent matches `agentId` in this workspace. |
| `agent_managed_read_only` | Target agent is a product-managed built-in. |
| `unauthorized` | Caller lacks the required org/workspace role, or is unauthenticated. |
