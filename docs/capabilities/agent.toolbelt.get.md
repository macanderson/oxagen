# get_agent_toolbelt

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

Every entry also carries the input schema the model is handed for that tool. A capability's is derived from the contract through the same conversion the runtime uses to advertise a tool, so the belt shows what the model receives rather than a second rendering of it. An MCP tool's comes from the registry version `import_tools` published, because a server's cached `tools/list` snapshot holds tool names and no schemas; a server whose tools were never imported reports no schema rather than a placeholder. The four schema fields are optional, so a reader written before them still parses the output.

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
| `tools[]` | object | `name`, `kind` (`capability` or `mcp`), `server` (`mcp_…` or null), `category`, `riskLevel`, `decision` (`allow` or `require_approval`), `rule`, `readOnly`, and the schema fields below. |
| `tools[].inputSchema` | `object \| null?` | The JSON Schema of the tool's input, as the model receives it. Null when nothing records one, and null when the schema is over 16 KiB. |
| `tools[].schemaOrigin` | `"declared" \| "imported" \| null?` | `declared` for a capability contract's own input, `imported` for a tool version published from a server's `tools/list`. Null exactly when no schema resolved. |
| `tools[].schemaDigest` | `string \| null?` | SHA-256 hex over the canonical (sorted-key) schema JSON. Present whenever a schema resolved, including a truncated one. Not the registry version's manifest checksum, which `list_tool_versions` reports under the same name. |
| `tools[].schemaTruncated` | `boolean?` | True when a schema resolved but was over the 16 KiB cap, so `inputSchema` is null and the full schema is one `list_tool_versions` read away. |
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
