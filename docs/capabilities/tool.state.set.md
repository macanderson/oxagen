# set_tool_state

**Capability:** `set_tool_state`
**Domain:** tool
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

An owner or admin decides which tools are available to toolbelts and which start active (ADR-198, #4369).

- `available` writes `agent.tools.enabled`. A tool that is not available is out of every belt, the All tools belt included, until it is made available again. A belt keeps its row for the tool, so the tool comes back as the belt left it.
- `defaultActive` writes `agent.tools.default_active`: whether the tool is active in the All tools belt and in a clone made from it afterwards. It does not change a belt that already holds the tool.

Target a list of tools, or every tool one server contributed. Neither changes a grant: roles, mandates and kill switches still decide each call.

## Input

| Field | Type | Notes |
|---|---|---|
| `toolIds` | `string[]?` | 1 to 200 tools (`tol_…`). Name these or `serverId`, not both. |
| `serverId` | `string \| null?` | Every tool this server contributed (`mcs_…`), or null for the declared and built-in tools. |
| `available` | `boolean?` | |
| `defaultActive` | `boolean?` | Set `available`, `defaultActive` or both. |

## Output

| Field | Type | Notes |
|---|---|---|
| `updated` | `number` | Tool rows whose state changed. A repeat that changes nothing writes nothing and answers 0. |

## Roles

Org Owner or Admin, or the workspace Owner, checked by the handler (INV-29).

## Side effects

- Postgres: `enabled` and `default_active` on the changed `agent.tools` rows.
- No domain security event. The kernel's `capability.invoke_*` audit records the call.

## Surfaces

- `POST /api/v1/{org}/{ws}/tools/state`
- MCP tool `set_tool_state`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No acting user (`no_principal`), or a role the contract does not grant (`org_role_required`). |
| `not_found` | A tool (`tool_not_found`) or the server (`tool_server_not_found`) is not in the workspace. |
