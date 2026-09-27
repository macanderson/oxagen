# delete_toolbelt

**Capability:** `delete_toolbelt`
**Domain:** toolbelt
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Delete a custom toolbelt that no live agent carries (ADR-198, #4369). The row is soft-deleted, so an agent version that named the belt still resolves it by id. Give the agents that carry it another belt first (`assign_agent_toolbelt`).

The handler locks the belt row before it counts carriers, and `assign_agent_toolbelt` and `register_agent` share-lock it before they give it to an agent, so an assignment racing the delete is either counted or refused.

## Input

| Field | Type | Notes |
|---|---|---|
| `toolbeltId` | `string` | A custom belt (`tbt_…`). |

## Output

| Field | Type | Notes |
|---|---|---|
| `toolbeltId` | `string` | |
| `deleted` | `true` | |

## Roles

Org Owner or Admin, or the workspace Owner, checked by the handler (INV-29).

## Side effects

- Postgres: sets `deleted_at` on the `tools.toolbelts` row. Its member rows stay.
- No domain security event. The kernel's `capability.invoke_*` audit records the call.

## Surfaces

- `POST /api/v1/{org}/{ws}/toolbelts/delete`
- MCP tool `delete_toolbelt`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No acting user (`no_principal`), or a role the contract does not grant (`org_role_required`). |
| `not_found` | No live toolbelt with that id (`toolbelt_not_found`). |
| `conflict` | The belt is the All tools belt (`all_tools_is_derived`), or a live agent carries it (`toolbelt_in_use`; the message says how many). |
