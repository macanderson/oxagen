# list_tool_versions

**Capability:** `list_tool_versions`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`; a console read is never a governed action, ADR-052 exclusion 2)

## Intent

The Tools page's registry table (MC spec §6.4, §6.9 part 1; ADR-072). Lists the workspace's tools with their active version: the capability id a call is governed under, read-only flag, risk grade (the classified grade, or the declared one while the version is unclassified), safety classification (null until an admin classifies the tool; a new version starts with the classification of the one it replaces), schema origin and digest, the kill switch that stops the version today, and its calls in the last 30 days.

The gate is decided with the same matcher the tool gateway uses (`matchKillSwitch`, `packages/iam/src/kill-switch.ts`) against the switches that are on, in the recorded decision order: a version switch, then a server switch, then a class switch matching one of the version's consequence tags. Workspace and organisation switches are the page header's, never a version's gate.

Calls in the last 30 days come from ClickHouse `tool_invocations` for the page's capability ids; when the store does not answer the column is null, never 0.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `category` | string | no | a consequence tag (`^[a-z][a-z0-9_]{1,63}$`); only versions carrying it |
| `serverId` | string | no | an `mcs_…` server id from `list_mcp_servers`; only versions imported from that server. Combines with `category`. An id that names no server in the workspace returns an empty page |
| `limit` | integer | no | 1-100, default 50 |
| `cursor` | string | no | the `nextCursor` of an earlier page; a cursor this capability did not write is `invalid_input` |

## Output

| Field | Type | Description |
|---|---|---|
| `items` | object[] | see the row below, by slug |
| `nextCursor` | string or null | null on the last page |

Each row:

| Field | Type | Description |
|---|---|---|
| `id` | string | `tlv_…` of the active version |
| `toolId` | string | `tol_…` |
| `slug`, `name`, `description` | string | the identity row |
| `version` | integer | version number |
| `source` | enum | `builtin`, `custom`, `mcp`, `foundry` |
| `serverId` | string or null | `mcs_…` for a tool imported from or declared against a server |
| `capabilityId` | string | the id a call is governed under: `mcp.<server uuid>.<tool>` for an imported tool, the slug otherwise |
| `readOnly` | boolean | |
| `riskGrade` | enum | `low`, `medium`, `high`, `critical` |
| `classification` | object or null | side-effect class, egress class, consequence tags, measures, data classes (`toolClassificationSchema`) |
| `classifiedAt` | string or null | RFC 3339 |
| `schemaOrigin` | enum | `declared`, `imported` |
| `schemaDigest` | string | SHA-256 hex over the canonical manifest |
| `enabled` | boolean | |
| `gate` | object | `{ kind: open \| killed_version \| killed_server \| killed_class, switchId: emd_… \| null }` |
| `calls30d` | integer or null | invocations in the last 30 days; null when ClickHouse did not answer |
| `updatedAt` | string | RFC 3339 |

## Roles

Org Owner or Admin, or any workspace role (Owner, Member, Viewer). The handler checks the role with `assertOrgRole` (INV-29).

## Side effects

None. Read-only; audit-exempt.

## Surfaces

- `POST /v1/{org}/{ws}/tools/versions`
- MCP tool `list_tool_versions` (an API key acts as its creator at the role gate, ADR-072 decision 8)
- App: **Tools → Registry** at `/{org}/{ws}/tools` — the tool versions table with its consequence-tag chips and the labels/API-names toggle.

## Errors

| code | meaning |
|---|---|
| `forbidden` (`HandlerError`, 403) | no signed-in user, or no qualifying role |
| `invalid_input` | a cursor this capability did not write |
