# tools.load

The belt definitions meta-tool (MC spec App. E, §6.6): the full definition of capabilities named from `search_tools`. Only a capability the in-app agent may call — one exposed on the `agent` surface — is described; a name outside that set comes back in `unknown` and describes nothing, so what the model cannot call it cannot be shown.

Inside a turn the engine-facing twin adds the loaded tools to what the next completion shows the provider, under the provider's per-request tool cap. This contract is the same read for a caller outside a turn.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/tools/load`
- MCP: `load_tools`
- Agent: `load_tools` (belt meta-tool)
- Authentication: session (org Owner, Admin or Member; workspace Owner, Member or Viewer)
- Capability name: `load_tools`
- Not billed (`noBillingGate: true`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `names` | string[] | yes | 1 to 8 capability names |

## Output

| Field | Type | Description |
|---|---|---|
| `tools` | object[] | `{ name, description, inputSchema, riskLevel, requiresApproval, readOnly }` for each name in the belt, in the order asked |
| `unknown` | string[] | names the belt does not hold |
