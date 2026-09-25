# set_kill_switch

**Capability:** `set_kill_switch`
**Domain:** kill_switch
**Mode:** sync
**Scope:** workspace (a class, operator, workspace or organisation switch is written org-wide and scoped by its `{ kind, id }` digest)
**Surfaces:** api, mcp, agent
**Approval:** `requiresApproval: true`; a flip from an agent pauses for a human
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; emergency governance is never refused for lack of GAUs)

## Intent

Kill switches at every level of MC spec §6.11 (ADR-072 §4, §5): a tool version, a tool server, a connection, an agent, an operator, a workspace, the organisation, or a class — every tool carrying a consequence tag. A switch is an `iam.emergency_denies` row that names its target; a tool version becomes a `capability` deny on the id its calls are governed under, every other kind a `resource_scope` deny over `resourceScopeDigestOf({ kind, id })`, the same digest the kernel's agent-run check and the tool gateway's gate derive from what a call carries.

The flip takes effect at the next call boundary through the deny generation: the row write bumps `iam.authorization_deny_generations` in the same transaction (the table's trigger), the handler reads the vector back on that transaction, and every cached allow keyed by the old generation is stale. A connection switch revokes the connection's live credential grants in the same transaction, and the tool gateway asks the gate about each server and its connection before the server is reached on later turns, so a connection or tool-server switch leaves the server out of the turn with no connect, no tools/list and no new grant. Every flip that changes a switch is a `tool.kill_switch_flipped` security event carrying the actor and the capability; a flip that finds the switch already on changes nothing and emits none. The row carries what the switch stops, who flipped it on and why (`flipped_by_user_id`, `reason`), and who cleared it and why (`updated_by_id`, `cleared_reason`).

## What a kill switch reaches, and what it does not

A switch is enforced in two places, and they are not the whole product:

- **The tool gateway's per-turn gate** (`packages/agent/src/runtime/kill-switch-gate.ts`). Every tool `materializeTools` presents — a capability the in-app agent may call, and every external MCP tool — is checked against the switches that are on, before the call and again after a person answers an approval or consent card. This is the path that matches `tool_server`, `connection` and `class` switches.
- **The kernel's agent-run IAM check** (`checkAgentRunIAM`, `packages/iam/src/check-iam.ts`). Emergency denies are consulted here for a call whose context carries an agent run.

The list `materializeTools` builds (`packages/agent/src/runtime/toolbelt.ts`) also leaves out a capability that an active deny names by its capability id, so the model is not shown a tool that every call would refuse. That holds for an agent run and for the in-app agent, which lists its tools as the person who asked.

The in-app agent also answers to the agent it runs as, the workspace's assistant agent. An `agent` switch on that agent refuses the whole turn before anything is written: `ask_assistant` answers `forbidden` with reason `kill_switch`. A switch flipped after that check still reaches the turn: the list leaves out the tools it cuts, and the per-turn gate refuses the calls it reaches. A person's own calls from the app do not answer to that switch.

An `operator`, `workspace`, `org` or `class` switch leaves the capability list as it is, and the per-turn gate refuses each call it reaches.

A switch **does not** stop a caller that carries neither. A customer agent holding an Oxagen API key against `api.oxagen.sh` or `mcp.oxagen.sh` invokes capabilities with `principalKind: "human"` and no `agentRun`, so `checkIAM` never reaches `checkAgentRunIAM` and no emergency deny is consulted. An `org`, `operator`, `workspace` or `class` switch therefore does not stop that traffic. Governing it means an IAM policy or revoking the key.

State this when an operator asks what a switch covers. An emergency control whose blast radius is overstated is worse than one whose limits are written down.

## Deleting what a switch names

While a switch is on, the delete paths that would hard-delete its target refuse with `conflict` / `kill_switch_on` (ADR-071): `revoke_plugin_credential` for a `connection` switch, and `uninstall_plugin` for a `tool_server` or `tool_version` switch. Both keyed on an internal uuid, so a delete-and-recreate would leave the switch reporting on while matching nothing. Turn the switch off first.

## A class switch and the two tag columns

A `class` switch matches a tool by its consequence tags, and a version carries those in two columns: `agent.tool_versions.consequence_tags` (the declared half, written by `publish_tool_declaration` and `import_tools` from the descriptor) and `classification->'consequenceTags'` (the classified half, written by `set_tool_classification`). Both draw on one vocabulary. The gate and `list_tool_versions` match on the **union**, so a tool tagged in either half is stopped.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `target.kind` | enum | yes | `tool_version`, `tool_server`, `connection`, `agent`, `operator`, `workspace`, `org`, `class` |
| `target.id` | string | yes | `tlv_…`, `mcs_…`, `mcrd_…`, `agt_…`, an operator's `usr_…` public id (their raw user uuid also works, kept for backward compatibility), a workspace id, the organisation id, or the consequence tag |
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
- MCP tool `set_kill_switch` (an API key acts as its creator at the role gate, ADR-072 decision 8)
- App: **Tools → Kill switches → Flip a kill switch** at `/{org}/{ws}/tools/switches`: the switch dialog states the blast radius and the deny-generation bump before the confirming button. The operator level's target is a member picker backed by `list_members`, so the dialog never asks for a uuid.

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, not Owner or Admin, or an organisation other than the caller's (`other_org`) |
| `not_found` (404) | the target does not exist in this scope (`<kind>_not_found`); for an operator, an unknown id or one outside the caller's org |
| `conflict` (409) | flipping off a switch that is not on (`switch_not_on`) |
| `pending_approval` | on the agent surface, until a human approves |
