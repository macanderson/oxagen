# assign_agent_toolbelt

**Capability:** `assign_agent_toolbelt`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Give an agent another toolbelt and keep its identity (ADR-198, #4369). One transaction writes the next `agent.agent_versions` row (`change_kind = 'toolbelt_changed'`) with the agent's current runtime and the new belt, copying the prior version's config forward, and moves `agent.agents.toolbelt_id`.

The principal, its roles and its grants do not change: a belt narrows what the agent is shown and never widens what it may do. An agent that names no belt carries the All tools belt, so assigning that belt to it is no change.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | The agent's public id (`agt_…`) or slug. |
| `toolbeltId` | `string` | `tbt_…`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | |
| `toolbelt` | object | `id`, `name`, `slug`, `kind`. |
| `version` | `number` | The version the assignment wrote. |

## Roles

Org Owner or Admin, checked by the handler (`assertOrgRole`, INV-29).

## Side effects

- Postgres: one `agent.agent_versions` row and the agent row's toolbelt and active version.
- No domain security event: a toolbelt grants nothing. The kernel's `capability.invoke_*` audit records the call.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/toolbelt/assign`
- MCP tool `assign_agent_toolbelt`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No acting user (`no_principal`), or the acting user is not an org Owner or Admin (`org_role_required`). |
| `not_found` | The agent (`agent_not_found`) or the toolbelt (`toolbelt_not_found`) is not in the workspace. |
| `conflict` | The agent is retired (`agent_retired`) or already carries the belt (`same_toolbelt`). |
