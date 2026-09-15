# agent.toolbelt.get

**Capability:** `get_agent_toolbelt`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

The belt an agent would be shown, computed and not executed (MC spec §6.6; #2956): the read behind the Agents detail page's toolbelt tab. For every capability on the agent surface and every discovered tool of the workspace's enabled MCP servers, the decision the runtime pipeline produced and the rule that decided it; how the belt was computed; what the model receives; and what the agent cannot see.

The decision per tool is the runtime's own: the handler calls the same per-tool function `materializeTools` calls before it builds a tool (`packages/agent/src/runtime/toolbelt.ts`), over the same inputs — the registry, the agent ∩ human resolution the kernel memoizes per run, the org's plugin entitlements, the run's effective MCP rules and the agent-subject consent ledger, and the active emergency denies the kernel enforces at invoke time. The caller is the initiating human of the delegation ceiling, so the belt is the one a run they start would carry. A `deny` puts the tool in `cannotSee` with the rule that excluded it; `allow` and `require_approval` put it in `tools`. A suspended or retired principal anchors no run, so its belt is empty and every tool is out of sight with rule `principal_suspended`.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | `agt_…` or slug. |
| `mode` | `"full" \| "searchable"?` | Force a presentation; omitted, the belt size against the limit (40) decides. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId`, `agentKey`, `computedAt` | | |
| `basis.humanCeiling` | `"caller" \| "sentinel"` | Whether the calling user's principal bounded the ceiling or the unprivileged sentinel did. |
| `basis.roleGrants` | `number` | Role-grant rows in the two principals' roles. |
| `basis.denyGeneration.org` / `.workspace` | `number` | The deny-generation counters the belt was computed under. |
| `basis.killSwitches` | `number` | Active emergency denies in scope. |
| `presentation.mode` / `.limit` / `.sentToModel` | | `definitions` in full mode, `meta_tools` in searchable mode. |
| `tools[]` | object | `name`, `kind` (`capability` or `mcp`), `server` (`mcp_…` or null), `category`, `riskLevel`, `decision` (`allow` or `require_approval`), `rule`, `readOnly`. |
| `cannotSee[]` | object | `name`, `kind`, `server`, `rule`. |

## Roles

Org Owner, Admin, Member; workspace Owner, Member.

## Side effects

None. Read-only; audit-exempt. A failed entitlement read excludes every plugin-claimed tool (fail closed), the rule the runtime applies.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/toolbelt`
- MCP tool `get_agent_toolbelt`

## Errors

| code | meaning |
|---|---|
| `not_found` | No live agent with that id or slug (`agent_not_found`). |
| `conflict` | The agent has no delegated principal (`agent_principal_missing`). |
