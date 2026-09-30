# get_studio_discovery

**Capability:** `get_studio_discovery`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`, a read spends no model tokens)

## Intent

Studio polls this while a discovery is queued or running, and reads it when a server's page opens. It returns one server folder's latest discovery: its status, what asked for it, when it ran, its outcome, the sync steering PR, and the tools the gateway withholds until that PR merges. It returns null before the server's first discovery.

Progress is the status. A discovery moves from `queued` to `running`, then ends `succeeded` or `failed`. It reports no percentage.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/`: a lowercase letter, then lowercase letters, digits, or underscores, 24 characters at most. `builtin` is reserved |

## Output

| Field | Type | Description |
|---|---|---|
| `discovery` | object or null | the latest discovery, or null before the first one |

A discovery carries these fields. Each date is an ISO 8601 string.

| Field | Type | Description |
|---|---|---|
| `id` | uuid | the row's id. Each server keeps one row, and each discovery overwrites it, so the id stays the same across runs |
| `server` | string | the folder name |
| `mcpServerId` | string or null | `mcs_…`, or null before the server has a registry row |
| `status` | enum | `queued`, `running`, `succeeded`, or `failed` |
| `trigger` | enum | what asked for it: `schedule`, `list_changed`, `push`, `registry_version`, `manual`, or `lock_merged` |
| `requestedAt` | date | when it was asked for |
| `requestedBy` | string or null | the person who asked, or null when the platform asked |
| `startedAt`, `finishedAt` | date or null | when the run started and finished |
| `error` | string or null | a failed run's message, with any credential scrubbed |
| `outcome` | enum or null | `unchanged`, `pr_opened`, `pr_updated`, `needs_digest` (a registry package has a newer version and the lock needs its digest), or `skipped`. Null until the run finishes, and on a failed run |
| `toolCount` | integer or null | the tools the source offered |
| `machine` | string or null | the machine that reported, for a local server or a registry package |
| `sourceKind`, `sourceRepo`, `sourcePath`, `sourceRef` | string or null | where the source was read from |
| `schedule` | enum or null | `server.toml`'s `sync.schedule`: `on-change`, `daily`, or `manual` |
| `upstreamDigest` | string or null | the digest of what the source offered |
| `latestVersion` | string or null | a registry server's newest catalog version |
| `pr` | object or null | the sync steering PR: `{ number, url, branch }` |
| `withheld` | string[] | full tool names the gateway hides until the sync steering PR merges |
| `stalled` | boolean | true when the discovery has sat `queued` or `running` for over an hour. A live run never gets this old, and the hourly sweep asks for a stalled server again |

## Roles

Org Owner or Admin, or workspace Owner, Member, or Viewer. The handler checks the role with `assertOrgRole` (INV-29). An API key acts as the person who created it.

## Side effects

None. The handler reads one `mcp.server_discoveries` row.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/discovery/get`
- MCP tool `get_studio_discovery`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `not_found` (404) | `mcp_server_not_found`: the name cannot be a server folder |
| `invalid_input` (400) | `server` is missing, malformed, or `builtin`, or the input carries another field |
