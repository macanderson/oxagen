# list_studio_tools

**Capability:** `list_studio_tools`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`, a read spends no model tokens)

## Intent

Studio's Tools tab shows what a server folder imports beside what its source offers. This capability returns both in two groups. First comes each `tools.toml` key on the steering repo's production branch, with the classification `tools.toml` states. Then comes each tool the last discovery found that no key imports, with the classification Studio suggests. Each row carries its definition tokens and whether the gateway withholds it, and the totals compare the imported tools' tokens with the server's definition budget.

[get_studio_draft](tool.studio.draft.get.md) returns only the edits Studio staged, and [list_agent_tools](agent.tool.list.md) returns the tools an agent may call. Neither reads the published folder beside the discovered tools.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |

## Output

| Field | Type | Description |
|---|---|---|
| `server` | string | the folder name |
| `mcpServerId` | string or null | `mcs_…`, or null before the server has a registry row |
| `snapshotId`, `capturedAt` | string or null | the newest `mcp.tool_snapshots` row among the offered tools, or null with none |
| `exposure` | object | `{ mode, budget }`: `direct` or `search`, and `definition_budget` from `server.toml` or the default |
| `tokens` | object | `{ definitions, budget }`: every imported tool's definition tokens together, null when the folder does not compile |
| `imported` | integer | the `tools.toml` key count |
| `offered` | integer | the tools the last discovery found |
| `searchRecommended` | boolean | true when a `direct` server's definitions exceed its budget |
| `compileError` | string or null | the compiler's message when the folder does not compile |
| `tools` | object[] | the imported rows, then the available rows |

Each row carries these fields.

| Field | Type | Description |
|---|---|---|
| `name` | string | the upstream name, as the source offers it |
| `key` | string or null | the `tools.toml` key, or null for an available tool |
| `state` | enum | `imported` or `available` |
| `description` | string or null | the upstream description |
| `importedDescription` | string or null | the description `tools.toml` gives, which replaces the upstream one |
| `inputSchema` | object | the input schema |
| `annotations` | object or null | the MCP hints, or null when the source gives none |
| `tokens` | integer or null | the definition's tokens. Null for an imported tool when the folder does not compile |
| `classification` | object | `{ risk, sideEffect, egress, impacts, confirmed, basis }`. `confirmed` is true when `tools.toml` states it. `basis` names the signal a suggestion came from, and is null for an imported tool |
| `snapshotId`, `capturedAt` | string or null | the `mcp.tool_snapshots` row the tool reads from. Null for an imported tool before the first discovery, or after the source drops it |
| `withheld` | boolean | true while the gateway hides the tool until the sync steering PR merges |

### Known limits

- An available tool's suggestion reads only what `mcp.tool_snapshots` keeps: the name, the description, the input schema, and the MCP hints. A snapshot keeps no request template, so an OpenAPI, GraphQL, or gRPC tool's suggestion falls back to `fail_safe`.
- An available tool's token count is an estimate that leaves out the title and the output schema.

## Roles

Org Owner or Admin, or workspace Owner, Member, or Viewer. The handler checks the role with `assertOrgRole` (INV-29). An API key acts as the person who created it.

## Side effects

None. The handler reads the folder's three files at the production branch's head, the server's `mcp.server_discoveries` row, the newest `mcp.tool_snapshots` row of each tool the last discovery offered, and the server's registry row.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/tools/list`
- MCP tool `list_studio_tools`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `mcp_server_not_found`: the name cannot be a server folder, or `server.toml` is not on the production branch |
| `conflict` (409) | `server_file_invalid`: `tools.toml` or `tools.lock.json` is missing or does not parse. The message names the file. Import the server in Studio to write it |
| `invalid_input` (400) | `server` is missing, malformed, or `builtin`, or the input carries another field |
