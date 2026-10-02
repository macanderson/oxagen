# search_steering

**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** mcp
**Risk level:** low

## Intent

An agent finds steering that its index did not list, or finds the lineage behind an index line before it reads the record. The search covers the two published versions the caller's workspace reads: the workspace's steering repo and the organization repo. It returns one index line per hit. It finds no tools. Tools come from the tool list or a server's own search tool. The agent reads a hit's body with [read_steering](steering.read.md).

Cursor reads all of its steering through this tool. Cursor's model calls go to Cursor's servers, so no steering block reaches its requests. A rule in Cursor's dashboard tells it to call this tool at the start of each task (`CURSOR_DASHBOARD_RULE` in `packages/steering-bundle/src/cursor.ts`).

A workspace with no published version gets no hits and null versions, not an error. When both versions hold a lineage, only the workspace's record comes back, the same record read_steering returns.

The steering repo spec proposed the name `steering_search`. ADR-025 puts the verb first.

## Input

| Field | Type | Notes |
|---|---|---|
| `query?` | `string` (≤500) | Words to look for in each record's label, description, and lineage. With no query, every record that fits the other filters matches, in lineage order. |
| `kind?` | record kind | Only records of this kind, such as `skill`. |
| `repository?` | `string` | Only records that reach a run on this code repository, such as `github.com/a-intel/platform`. |
| `limit?` | `int` (1–50) | How many hits to return. 10 when unset. |

## Output

| Field | Type | Notes |
|---|---|---|
| `workspace_version` | `int` or null | The workspace version searched. Null before its first publish. |
| `organization_version` | `int` or null | The organization version searched. Null before its first publish. |
| `hits` | array | `{ lineage, label, description?, kind, force, always_on, source, line }` for each hit, best match first. |
| `hits[].always_on` | `boolean` | True when the always-on block of a run on `repository` holds the record: the version's block for that repository, else its block for every other repository. With no `repository`, that second block. A record whose tool target no server provides is never always on. |
| `hits[].source` | `"workspace"` or `"organization"` | The version the hit came from. |
| `hits[].line` | `string` | The record's index line. |
| `total` | `int` | How many records matched before the limit. |

## Versions

A call reads the versions published now. The MCP surface carries no run id. A call that names a run is refused as `not_found: steering_run_versions_unrecorded`, because Oxagen does not yet record which versions a run received (`packages/handlers/src/steering.published.ts`).

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member, Workspace Viewer.

## Side effects

None. Not billed (`noBillingGate: true`).
