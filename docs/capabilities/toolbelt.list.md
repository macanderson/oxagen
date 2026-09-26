# list_toolbelts

**Capability:** `list_toolbelts`
**Domain:** toolbelt
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

The workspace's toolbelts, its All tools belt first and then the belts cloned from it by name, with the counts each one holds (ADR-192, #4369).

A toolbelt is the set of tools an agent is shown. It narrows what an agent can reach and never widens a grant: roles, mandates and kill switches still decide each call. The All tools belt holds every tool an owner or admin made available (`set_tool_state`), each active as its workspace default says. A custom belt is a clone with its own members (`clone_toolbelt`, `update_toolbelt`).

The first toolbelt path to touch a workspace creates its All tools belt, so this read can insert that one row. `availableTools` is the count the register form reads: when it is zero the workspace has imported no tool an agent could be shown, and the form's toolbelt step completes itself and links to the page that imports MCP servers.

## Input

None (`{}`).

## Output

| Field | Type | Notes |
|---|---|---|
| `items[].id` | `string` | `tbt_…`. |
| `items[].name`, `slug` | `string` | |
| `items[].kind` | `"all_tools" \| "custom"` | |
| `items[].description` | `string \| null` | |
| `items[].clonedFrom` | object \| null | `{ id, name, slug, kind }` of the source belt; null on the All tools belt. |
| `items[].tools` | `number` | Available tools the belt holds, active or not. |
| `items[].activeTools` | `number` | The ones it shows an agent. |
| `items[].servers` | `number` | Servers it holds a tool from; declared tools count as one. |
| `items[].agents` | `number` | Live agents carrying it. An agent that names no belt carries All tools. |
| `items[].updatedAt` | `string` | ISO-8601. |
| `availableTools` | `number` | Tools an owner or admin made available in the workspace. |

## Roles

Org Owner, Admin; workspace Owner, Member, Viewer.

## Side effects

The first call in a workspace inserts its All tools belt (`tools.toolbelts`, `kind = 'all_tools'`). Every call after writes nothing. Audit-exempt.

## Surfaces

- `POST /api/v1/{org}/{ws}/toolbelts`
- MCP tool `list_toolbelts`
