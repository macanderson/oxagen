# move_agent

**Capability:** `move_agent`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Put an agent on another runtime and keep its identity (ADR-192, #4369). A move is how an agent survives new hardware or a cloud migration: the principal, its roles, its credentials and its runs stay.

One transaction:

1. locks the agent and checks the new runtime does not already run a live agent with the same harness,
2. writes the next `agent.agent_versions` row (`change_kind = 'runtime_changed'`) with the new runtime and the agent's current toolbelt, copying the prior version's config forward,
3. moves `agent.agents.runtime_id`,
4. revokes every live host enrollment under the agent's key with the writes `revoke_tacho_enrollment` makes. A live host holds the agent key, so the new machine cannot enroll until the old one lets it go.

Enroll the new machine with a token minted for the agent (`create_enrollment_token`).

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | The agent's public id (`agt_…`) or slug. |
| `runtimeId` | `string` | `rtm_…`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | |
| `runtime` | object | `id`, `name`, `slug`. |
| `version` | `number` | The version the move wrote. |
| `revokedHosts` | `number` | Host enrollments the move revoked. |

## Roles

Org Owner or Admin, checked by the handler (`assertOrgRole`, INV-29).

## Side effects

- Postgres: one `agent.agent_versions` row, the agent row's runtime and active version, and for each revoked host the host status, its keys and a queued `revoke` command.
- Security event `api_key.revoked` when a host was revoked.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/move`
- MCP tool `move_agent`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No acting user (`no_principal`), or the acting user is not an org Owner or Admin (`org_role_required`). |
| `not_found` | The agent (`agent_not_found`) or the runtime (`runtime_not_found`) is not in the workspace. |
| `conflict` | The agent is retired (`agent_retired`), already runs on the runtime (`same_runtime`), or a live agent already runs its harness there (`runtime_harness_taken`). |
