# update_toolbelt

**Capability:** `update_toolbelt`
**Domain:** toolbelt
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Rename a custom toolbelt and edit its tools (ADR-192, #4369). Each change applies in order, in one transaction, and each sees the ones before it:

| `op` | Effect |
|---|---|
| `remove_server` | Deletes every row the belt holds from that server. |
| `add_server` | Adds every available tool from that server the belt does not hold yet, active or not as `active` says (default true). |
| `set_server_active` | Turns every tool the belt holds from that server on or off in the belt. |
| `set_tool_active` | Turns one tool on or off in the belt, adding it when the belt does not hold it. |

`serverId` is `mcs_…`, or null for the workspace's declared and built-in tools. An agent carrying the belt sees the change on its next belt read. The belt narrows what an agent is shown and never widens a grant.

The All tools belt follows the workspace's tool settings and cannot be edited: clone it, or change a tool's availability or default with `set_tool_state`.

## Input

| Field | Type | Notes |
|---|---|---|
| `toolbeltId` | `string` | A custom belt (`tbt_…`). |
| `name` | `string?` | 1 to 128 characters. |
| `description` | `string \| null?` | Up to 1024 characters; null clears it. |
| `changes[]` | object | Up to 200, as the table above. Default empty. |

## Output

| Field | Type | Notes |
|---|---|---|
| `toolbelt` | object | `id`, `name`, `slug`, `kind`. |

## Roles

Org Owner or Admin, or the workspace Owner, checked by the handler (INV-29).

## Side effects

- Postgres: inserts, updates and deletes on `tools.toolbelt_tools`; the belt's `name`, `description` and `updated_at`.
- No domain security event. The kernel's `capability.invoke_*` audit records the call.

## Surfaces

- `POST /api/v1/{org}/{ws}/toolbelts/update`
- MCP tool `update_toolbelt`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No acting user (`no_principal`), or a role the contract does not grant (`org_role_required`). |
| `not_found` | The belt (`toolbelt_not_found`), a server (`tool_server_not_found`) or a tool (`tool_not_found`) is not in the workspace. |
| `conflict` | The belt is the All tools belt (`all_tools_is_derived`), or a change turns on a tool an owner or admin has not made available (`tool_unavailable`). |
