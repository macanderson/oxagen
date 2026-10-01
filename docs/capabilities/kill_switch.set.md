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

Kill switches at every level of MC spec §6.11 (ADR-072 §4, §5): a tool version, a tool server, a connection, an agent, an operator, a workspace, the organisation, or a class — every tool carrying an impact. A switch is an `iam.emergency_denies` row that names its target; a tool version becomes a `capability` deny on the id its calls are governed under, every other kind a `resource_scope` deny over `resourceScopeDigestOf({ kind, id })`, the same digest the kernel's agent-run check and the tool gateway's gate derive from what a call carries.

The flip takes effect at the next call boundary through the deny generation: the row write bumps `iam.authorization_deny_generations` in the same transaction (the table's trigger), the handler reads the vector back on that transaction, and every cached allow keyed by the old generation is stale. A connection switch revokes the connection's live credential grants in the same transaction, and the tool gateway asks the gate about each server and its connection before the server is reached on later turns, so a connection or tool-server switch leaves the server out of the turn with no connect, no tools/list and no new grant. Every flip that changes a switch is a `tool.kill_switch_flipped` security event carrying the actor and the capability; a flip that finds the switch already on changes nothing and emits none. The row carries what the switch stops, who flipped it on and why (`flipped_by_user_id`, `reason`), and who cleared it and why (`updated_by_id`, `cleared_reason`).

## Coverage

A switch is enforced in three places, and they are not the whole product:

- **The tool gateway's per-turn gate** (`packages/agent/src/runtime/kill-switch-gate.ts`). Every tool `materializeTools` presents is checked against the switches that are on, before the call and again after a person answers an approval or consent card. This is the path that matches `tool_server`, `connection` and `class` switches. The gate also matches every other active emergency deny, including one another writer left with no target that names a principal, so the list and the gate answer from the same rows.
- **The kernel's agent-run IAM check** (`checkAgentRunIAM`, `packages/iam/src/check-iam.ts`). Emergency denies are consulted here for a call whose context carries an agent run.
- **The served steering tools** (`apps/mcp/src/servers/kill-switch.ts`). Before mcp.oxagen.sh sends a call to a tool a steering repository publishes, it checks the call through the same per-turn gate. The switches that reach it are on the tool (`tool_version`), its server (`tool_server`), the service credential it signs in with (`connection`), the operator who enrolled the host, the workspace, the organization, and the tool's classes. A switch that reaches the call stops it before Oxagen opens an approval or reads a credential, and the meter records the call as denied. An `agent` switch does not reach it, because a steering agent is a file in the repository with no `agt_` id. An operator's own OAuth token is not a connection, so no `connection` switch reaches a call that signs in with one.

The list `materializeTools` builds (`packages/agent/src/runtime/toolbelt.ts`) also leaves out every capability a switch reaches, so the model is not shown a tool that every call would refuse. The list matches a switch on the same facts the per-turn gate uses: the capability id, the organization, the workspace, the operator, the agent, and the classes the capability's tool version carries. That holds for an agent run. `get_agent_toolbelt` reports the same cut under the rule `kill_switch`. A `tool_server` or `connection` switch applies to external tools only, and the per-turn gate checks those on every call.

Your switches do not reach Oxagen's in-app assistant, stella (ADR-235). A call its turn makes passes every `tool_version`, `operator`, `workspace`, `org`, and `class` switch, and the list keeps the tools those switches cut. Turning a switch on or off against the workspace's managed assistant agent answers `forbidden` with reason `agent_managed_read_only`. Oxagen switches the assistant off itself with the platform-only `set_assistant_switch`. That writes the `agent` switch on the assistant agent, which refuses the whole turn before anything is written: `ask_assistant` answers `forbidden` with reason `kill_switch`. A switch flipped after that check still reaches the turn: the list leaves out the tools it cuts, and the per-turn gate refuses the calls it reaches. A call a person approved after stella parked it answers to the switch too.

An `operator`, `workspace`, `org` or `class` switch removes the capabilities it covers from the list, and the per-turn gate refuses each call it reaches.

A switch **does not** stop a call that reaches none of them. A customer agent holding an Oxagen API key against `api.oxagen.sh` or `mcp.oxagen.sh` invokes capabilities with `principalKind: "human"` and no `agentRun`, so `checkIAM` never reaches `checkAgentRunIAM` and no emergency deny is consulted. An `org`, `operator`, `workspace` or `class` switch therefore does not stop that traffic. Governing it means an IAM policy or revoking the key. A served steering tool on `mcp.oxagen.sh` is the exception, because the third check above runs on every call to one.

State this when an operator asks what a switch covers. An emergency control whose blast radius is overstated is worse than one whose limits are written down.

## Deleting what a switch names

While a switch is on, the delete paths that would hard-delete its target refuse with `conflict` / `kill_switch_on` (ADR-071): `revoke_plugin_credential` for a `connection` switch, and `uninstall_plugin` for a `tool_server` or `tool_version` switch. Both keyed on an internal uuid, so a delete-and-recreate would leave the switch reporting on while matching nothing. Turn the switch off first.

## A class switch and the two tag columns

A `class` switch matches a tool by its impacts, and a version carries those in two columns: `agent.tool_versions.impacts` (the declared half, written by `publish_tool_declaration` and `import_tools` from the descriptor) and `classification->'impacts'` (the classified half, written by `set_tool_classification`). Both draw on one vocabulary. The gate and `list_tool_versions` match on the **union**, so a tool tagged in either half is stopped.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `target.kind` | enum | yes | `tool_version`, `tool_server`, `connection`, `agent`, `operator`, `workspace`, `org`, `class` |
| `target.id` | string | yes | `tlv_…`, `mcs_…`, `mcrd_…`, `agt_…`, an operator's `usr_…` public id (their raw user uuid also works, kept for backward compatibility), a workspace id, the organisation id, or the impact |
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
