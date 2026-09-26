# clone_toolbelt

**Capability:** `clone_toolbelt`
**Domain:** toolbelt
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Copy a toolbelt into a new custom belt you can edit (ADR-198, #4369). The clone holds every tool the source holds, each active as it is in the source:

- From the All tools belt: every available tool, active as its workspace default says.
- From a custom belt: every row the source has, as the source left it. A row for a tool that is unavailable now is copied too, so the tool comes back in the clone once an owner or admin makes it available again.

Edit the clone with `update_toolbelt`, and give it to an agent with `assign_agent_toolbelt` or at registration.

## Input

| Field | Type | Notes |
|---|---|---|
| `toolbeltId` | `string` | The belt to copy (`tbt_…`). |
| `name` | `string` | 1 to 128 characters. |
| `slug` | `string?` | 1 to 40 characters. Derived from `name` when absent, by the same rule as every name-made slug. `all-tools` belongs to the All tools belt. |
| `description` | `string?` | Up to 1024 characters. |

## Output

| Field | Type | Notes |
|---|---|---|
| `toolbelt` | object | `id` (`tbt_…`), `name`, `slug`, `kind` (`custom`). |

## Roles

Org Owner or Admin, or the workspace Owner, checked by the handler (INV-29).

## Side effects

- Postgres: one `tools.toolbelts` row and one `tools.toolbelt_tools` row per copied tool.
- No domain security event: a toolbelt narrows what an agent is shown and grants nothing. The kernel's `capability.invoke_*` audit records the call.

## Surfaces

- `POST /api/v1/{org}/{ws}/toolbelts/clone`
- MCP tool `clone_toolbelt`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No acting user (`no_principal`), or a role the contract does not grant (`org_role_required`). |
| `not_found` | No live toolbelt with that id (`toolbelt_not_found`). |
| `conflict` | Another live belt holds the slug, or the slug is `all-tools` (`toolbelt_slug_taken`); or the name has no letter or digit to derive a slug from (`toolbelt_slug_empty`). |
