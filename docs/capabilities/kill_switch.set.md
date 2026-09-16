# kill_switch.set

**Capability:** `set_kill_switch`
**Domain:** kill_switch
**Mode:** sync
**Scope:** workspace (a class, operator, workspace or organisation switch is written org-wide and scoped by its `{ kind, id }` digest)
**Surfaces:** api, mcp, agent
**Approval:** `requiresApproval: true`; a flip from an agent pauses for a human
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; emergency governance is never refused for lack of GAUs)

## Intent

Kill switches at every level of MC spec §6.11 (ADR-068 §4, §5): a tool version, a tool server, a connection, an agent, an operator, a workspace, the organisation, or a class — every tool carrying a consequence tag. A switch is an `iam.emergency_denies` row that names its target; a tool version becomes a `capability` deny on the id its calls are governed under, every other kind a `resource_scope` deny over `resourceScopeDigestOf({ kind, id })`, the same digest the kernel's agent-run check and the tool gateway's gate derive from what a call carries.

The flip takes effect at the next call boundary through the deny generation: the row write bumps `iam.authorization_deny_generations` in the same transaction (the table's trigger), the handler reads the vector back on that transaction, and every cached allow keyed by the old generation is stale. A connection switch revokes the connection's live credential grants in the same transaction, and the tool gateway asks the gate about each server and its connection before the server is reached on later turns, so a connection or tool-server switch leaves the server out of the turn with no connect, no tools/list and no new grant. Every flip that changes a switch is a `tool.kill_switch_flipped` security event carrying the actor and the capability; a flip that finds the switch already on changes nothing and emits none. The row carries what the switch stops, who flipped it on and why (`flipped_by_user_id`, `reason`), and who cleared it and why (`updated_by_user_id`, `cleared_reason`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `target.kind` | enum | yes | `tool_version`, `tool_server`, `connection`, `agent`, `operator`, `workspace`, `org`, `class` |
| `target.id` | string | yes | `tlv_…`, `mcs_…`, `mcrd_…`, `agt_…`, a user id, a workspace id, the organisation id, or the consequence tag |
| `on` | boolean | yes | |
| `reason` | string | yes | 1-500 characters; recorded on the row as `reason` when flipping on and as `cleared_reason` when flipping off; not recorded when the switch is already on |

## Output

| Field | Type | Description |
|---|---|---|
| `switchId` | string | `emd_…` of the row written or cleared |
| `on` | boolean | |
| `changed` | boolean | false when the switch was already in the requested state |
| `denyGeneration` | object | `{ org, workspace }` after the flip |
| `grantsRevoked` | integer | credential grants a connection switch revoked |

## Roles

Org Owner or Admin (`assertOrgRole`, INV-29).

## Side effects

Writes `iam.emergency_denies` (insert on; `active = false`, `deactivated_at`, `cleared_reason` off — the row is kept); bumps the deny generation (trigger); revokes `mcp.credential_grants` for a connection switch; emits `tool.kill_switch_flipped` when the flip changed a switch.

## Surfaces

- `PUT /v1/{org}/{ws}/kill-switches`
- MCP tool `set_kill_switch` (an API key acts as its creator at the role gate, ADR-068 decision 8)

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, not Owner or Admin, or an organisation other than the caller's (`other_org`) |
| `not_found` (404) | the target does not exist in this scope (`<kind>_not_found`) |
| `conflict` (409) | flipping off a switch that is not on (`switch_not_on`) |
| `pending_approval` | on the agent surface, until a human approves |
