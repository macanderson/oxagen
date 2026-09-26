# get_toolbelt

**Capability:** `get_toolbelt`
**Domain:** toolbelt
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

One toolbelt with every tool in the workspace grouped by the server it came from (ADR-192, #4369). The editor behind the Toolbelts tab.

The declared and built-in tools come first as one group, then each live MCP server by name, including a server whose tools were never imported (a group with no tools). A group the belt holds no tool from reads `included: false`, so a clone's editor can add it back. On the All tools belt every group with a tool is included, a tool an owner or admin has not made available reads `available: false`, and `active` is the tool's workspace default.

## Input

| Field | Type | Notes |
|---|---|---|
| `toolbeltId` | `string` | `tbt_…`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `toolbelt` | object | `id`, `name`, `slug`, `kind`, `description`, `clonedFrom`, `updatedAt`. |
| `groups[].server` | object | `id` (`mcs_…`, or null for the declared tools) and `name`. |
| `groups[].included` | `boolean` | The belt holds at least one tool from the server. |
| `groups[].tools[]` | object | `id` (`tol_…`), `slug`, `name`, `description`, `available`, `defaultActive`, `active`, `member`. |
| `agents[]` | object | `id`, `name`, `slug` of each live agent carrying the belt, at most 500. |

## Roles

Org Owner, Admin; workspace Owner, Member, Viewer.

## Side effects

None. Read-only; audit-exempt.

## Surfaces

- `POST /api/v1/{org}/{ws}/toolbelts/get`
- MCP tool `get_toolbelt`

## Errors

| code | meaning |
|---|---|
| `not_found` | No live toolbelt with that id in the workspace (`toolbelt_not_found`). |
