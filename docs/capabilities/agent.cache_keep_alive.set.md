# set_agent_cache_keep_alive

**Capability:** `set_agent_cache_keep_alive`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Turn the cache keep-alive on or off for one agent in the active workspace (spend spec, detector 3; lane F32). While a parent run waits on a subagent, its cached prompt can expire, and the next turn pays to write the cache again. The tacho model proxy can resend the parent's last request with `max_tokens` 0 so the cached prompt stays warm. It sends one only when the agent's idle cache finding shows the keep-alive costs less than the cache rewrites it saves.

The keep-alive is on by default (`agent.agents.cache_keep_alive` is true for every agent). This write lets the team that owns the agent turn it off for that agent, or back on. `get_agent` reports the setting as `identity.cacheKeepAlive`.

## Input

| Field | Type | Notes |
|---|---|---|
| `agent` | `string` | The agent's slug in the active workspace. |
| `cacheKeepAlive` | `boolean` | `true` turns the keep-alive on; `false` turns it off. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | The agent's public id (`agt_…`). |
| `cacheKeepAlive` | `boolean` | The setting the agent now holds. |

## Roles

Org Owner or Admin, checked by the handler (`assertOrgRole`, INV-29).

## Side effects

- Postgres: the agent row's `cache_keep_alive`, `updated_at` and `updated_by_id`.
- No domain security event: no event type fits a settings toggle. The kernel's `capability.invoke_*` audit records the call.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/cache-keep-alive/set`
- MCP tool `set_agent_cache_keep_alive`
- App: the agent page's Overview tab, Coaching panel, Cache keep-alive row.
- Agent: off the agent surface. The team that owns the agent decides whether the gateway spends tokens to keep its cache warm.

## Errors

| code | meaning |
|---|---|
| `forbidden` | No acting user (`no_principal`), or the acting user is not an org Owner or Admin (`org_role_required`). |
| `not_found` | No live agent in this workspace has that slug (`agent_not_found`), or the call has no workspace in scope (`workspace_required`). |
