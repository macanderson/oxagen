# get_studio_server

**Capability:** `get_studio_server`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`, a read spends no model tokens)

## Intent

Studio's server page shows one server folder: where it comes from, how it signs in, its environments, when it last synced, how the gateway shapes each tool, and the tools themselves (#4678). This capability returns all of it from one read of the steering repo's production branch, so the page never joins two reads taken at two commits.

The catalog is the one [list_studio_tools](tool.studio.tools.list.md) returns, with the same fields and the same refusals. [get_studio_draft](tool.studio.draft.get.md) returns only the edits Studio staged, and [get_studio_discovery](tool.studio.discovery.get.md) returns the last discovery alone.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |

## Output

Every field of [list_studio_tools](tool.studio.tools.list.md#output), and these.

| Field | Type | Description |
|---|---|---|
| `folder` | string | the folder, such as `tools/servers/stripe` |
| `label` | string | `server.toml`'s label |
| `description` | string | `server.toml`'s description |
| `source` | object | `server.toml`'s `[source]`, with its keys in camelCase. See below |
| `auth` | object | `{ mode, scheme, credential }`. A server the local gateway runs has no `[auth]` table, and reads as mode `none` |
| `environments` | object[] | each `[environments.<name>]` table: `{ name, sandbox, url, network, credential }`, in the order `server.toml` lists them |
| `sync` | object | `{ schedule, lastAt }`: `on-change`, `daily`, or `manual`, and when the last discovery finished. `lastAt` is null when that discovery failed or none ran |
| `shaping` | object[] | each `tools.toml` key's shaping: `{ tool, hide, fixed, select, selection }`. Each fixed value is JSON text |
| `feedback` | object | `{ windowDays, tools }`: each `tools.toml` key's agent feedback over the last 30 days. See below |

`source` takes one of four shapes.

| `type` | Fields |
|---|---|
| `remote` | `url`, `transport`, `network` |
| `registry` | `registry`, `server`, `version`, `network`, `machines`, `registryType`, `env` |
| `local` | `command`, `args`, `env`, `machines` |
| `openapi`, `graphql`, `grpc` | `from`, `repo`, `path`, `ref`, `url`, `network` |

Each entry of `feedback.tools` is `{ tool, counts, notes }`, in the order `tools.toml` lists the keys (ADR-234).

| Field | Description |
|---|---|
| `tool` | the `tools.toml` key |
| `counts` | `{ calls, schemaRejections, errorResults, retries }` from the served tools' calls, or null when ClickHouse did not answer. A key no agent called reads zeros |
| `notes` | what reflections' `tool_feedback` said about the tool, newest first, at most five, with repeats dropped |

A call counts when it reached the tool check. A schema rejection is a call the tool's input schema refused, or whose arguments Cedar could not read. An error result is a call the tool answered with an error. A retry is a later call to the same tool in a run that already had one of those. A call denied by policy or parked for approval is not counted.

A credential appears only as its vault reference (`oxagen:credential/<name>`), and `env` lists variable names, never values. A registry source's `arguments` are left out, because a value there may be a literal.

## Roles

Org Owner or Admin, or workspace Owner, Member, or Viewer. The handler checks the role with `assertOrgRole` (INV-29). An API key acts as the person who created it.

## Side effects

None. The handler reads the folder's three files at the production branch's head, the server's `mcp.server_discoveries` row, the newest `mcp.tool_snapshots` row of each tool the last discovery offered, and the server's registry row. For feedback it reads ClickHouse `served_tool_calls` and the newest 200 `agent.memory_reflections` rows with tool feedback in the window.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/server/get`
- MCP tool `get_studio_server`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `mcp_server_not_found`: the name cannot be a server folder, or `server.toml` is not on the production branch |
| `conflict` (409) | `server_file_invalid`: `tools.toml` or `tools.lock.json` is missing or does not parse. The message names the file. Import the server in Studio to write it |
| `invalid_input` (400) | `server` is missing, malformed, or `builtin`, or the input carries another field |
