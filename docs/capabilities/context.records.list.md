# list_records

**Name:** `list_records`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Billing:** `noBillingGate: true` — a console read is outside the metering surface (ADR-052 exclusion 2)
**Mutates:** no

## Intent

List the workspace's published steering records: what is in force on the production branch, with the classification the Records tab renders — kind, force, constraint effect, scope, lineage, the merge commit and the file path ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §10.2, App. E). A record reaches this list by a merged Context PR (`merge_context_pr`) or through `publish_context_record`.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | `rule \| constraint \| procedure \| fact \| memory \| preference`? | The six kinds of context-record/v0.1 |
| `sharingScope` | `repository \| workspace`? | Where the record applies (spec §10.2) |
| `status` | `active \| retired \| superseded`? | Lifecycle status |
| `lineageId` | `string`? | One lineage (the file stem) |
| `limit` | `int` | 1–200, default 50 |
| `offset` | `int` | Default 0 |

## Output

| Field | Type | Source |
| --- | --- | --- |
| `records[].id` | `string` | `agent.context_records.public_id` (`ctr_…`) |
| `records[].lineageId` | `string` | `context_records.slug` — the lineage id and the file stem |
| `records[].title` | `string` | `context_records.title` |
| `records[].kind` / `.force` / `.constraintEffect` / `.statement` | nullable | Written by `merge_context_pr` and, since #3302, by `publish_context_record`. Null only on a record predating both, or a version predating migration `20260918160000` |
| `records[].sharingScope` | `repository \| workspace` | `context_records.sharing_scope` |
| `records[].status` | `active \| retired \| superseded` | `context_records.status` |
| `records[].version` / `.checksum` | nullable | The active `context_record_versions` row |
| `records[].commit` / `.path` / `.publishedAt` | nullable | The merge commit on the production branch and the file it holds; null when no Context PR published it |
| `records[].updatedAt` | RFC 3339 | `context_records.updated_at` |
| `total` | `int` | The count ignoring `limit`/`offset` |

## Semantics

- Workspace-bound: rows are filtered on the context's org and workspace, and the tenant policy on `agent.context_records` filters the same way.
- Newest change first, then by lineage.

## Errors

| code | meaning |
| --- | --- |
| `invalid_input` | A kind outside the six, `limit` outside 1–200, or an unknown field. |
