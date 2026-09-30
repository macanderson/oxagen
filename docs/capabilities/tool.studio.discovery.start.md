# start_studio_discovery

**Capability:** `start_studio_discovery`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`, discovery reads a server's tool list and spends no model tokens)

## Intent

You changed a server, or you want to know now whether its tools moved. This capability asks for one discovery of one server folder, whatever `sync.schedule` in its `server.toml` says. It returns the queued discovery at once, and the run happens in the background. Read its progress with [get_studio_discovery](tool.studio.discovery.get.md).

A discovery reads `server.toml`, `tools.toml`, and `tools.lock.json` on the steering repo's production branch, reads the tools the source offers, and writes each one to `mcp.tool_snapshots`. When an imported tool changed, it opens or updates the server's sync steering PR with the new lock. A tool whose input schema changed, and a tool the new lock drops, stay withheld from the gateway until that PR merges.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |

## Output

| Field | Type | Description |
|---|---|---|
| `discovery` | object | the server's discovery, read right after the request. It reads `queued` with the trigger `manual` until the run starts |

[get_studio_discovery](tool.studio.discovery.get.md) describes each field of a discovery.

## Roles

Org Owner or Admin, or workspace Owner or Member: the roles that may edit tools. The handler checks the role with `assertOrgRole` (INV-29). An API key acts as the person who created it.

## Side effects

- The handler upserts the server's one `mcp.server_discoveries` row as `queued`, with the trigger `manual` and you as the requester.
- It sends one `mcp-server/discover.requested` event. The discover function runs one discovery at a time per server. A run times out after 10 minutes and retries twice.
- The run writes `mcp.tool_snapshots` rows, and it may open or update the sync steering PR. The new lock reaches production only when that PR merges. Until then the gateway withholds each tool whose input schema changed and each tool the new lock drops.

The contract declares the server folder (`tool_server_folder`) as its audit target.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/discovery/start`
- MCP tool `start_studio_discovery`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `mcp_server_not_found`: the name cannot be a server folder |
| `invalid_input` (400) | `server` is missing, malformed, or `builtin`, or the input carries another field |

The request never fails because the source is down. A run that cannot read the source ends `failed`, and `get_studio_discovery` returns its message.
