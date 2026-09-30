# get_studio_listing

**Capability:** `get_studio_listing`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

You asked a machine to list a draft's tools with [start_studio_listing](tool.studio.listing.start.md), and you want to know whether it has. This capability reads the draft's listing: its status, the pin the machine checks, the machine that answered, how many tools it listed, and why a listing failed. Studio polls it while the listing runs, and reads the draft again once it succeeds, because the listing saved the draft.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `server` | string | yes | the folder name under `tools/servers/` |

## Output

| Field | Type | Description |
|---|---|---|
| `listing` | object or null | the draft's listing, or null when it has none |
| `listing.status` | enum | `waiting_for_machine`, `running`, `succeeded`, or `failed` |
| `listing.machineGroups` | string[] | `source.machines` when the listing was asked |
| `listing.pin` | object | `name`, `version`, `digest`, and `registryType` (null for a local command) |
| `listing.draftRevision` | integer | the draft revision the listing was asked on |
| `listing.requestedAt`, `listing.requestedBy` | string | when and who asked |
| `listing.claimedAt`, `listing.finishedAt` | string or null | when a machine's process claimed it, and when it finished |
| `listing.machine` | string or null | the machine that answered tools/list |
| `listing.toolCount` | integer or null | how many tools the machine listed |
| `listing.error` | string or null | why the listing failed |

## Roles

Org Owner or Admin, or workspace Owner: the roles that read a draft. The handler checks the role with `assertOrgRole` (INV-29).

## Side effects

None. It reads one `mcp.studio_listings` row.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/listing/get`
- MCP tool `get_studio_listing`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `invalid_input` (400) | `server` is missing or malformed, or the input carries another field |
