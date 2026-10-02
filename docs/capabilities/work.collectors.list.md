# list_work_collectors

List the workspace's work collectors with their repositories and health (lane P1-03, #5103).

**Surfaces:** api, mcp

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/collectors/list`, returns 200
- MCP: `list_work_collectors`
- Authentication: org Owner or Admin, or workspace Owner, Member, or Viewer, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface.

## Input

None.

## Output

`collectors[]`, oldest first:

| Field | Type | Notes |
| --- | --- | --- |
| `collector_id` | `uuid` | |
| `name` | `string` | |
| `type` | `github` | Phase 1 ships GitHub Issues only |
| `connection_id` | `string` or `null` | The GitHub connection's `con_…` id |
| `repos` | `string[]` | The repositories it reads, as `owner/name` |
| `health` | `healthy`, `lagging`, `failing`, or `paused` | |
| `cursor` | `string` or `null` | Where the next reconcile starts reading |
| `last_reconcile` | object or `null` | The latest reconcile: when, whether it finished, pages, issues read, changes a webhook missed, and the error |
| `last_success_at` | `string` or `null` | When a reconcile last finished |
| `failed_streak` | `int` | Failed reconciles since the last one that finished |
| `next_check_at` | `string` or `null` | When the next scheduled reconcile reads. Null while paused or failing |
| `last_event_at` | `string` or `null` | When the latest webhook delivery arrived |
| `created_at` | `string` | |

## Semantics

A reconcile runs every 15 minutes and reads what changed since the cursor. Health reads `lagging` when a reconcile found changes a webhook missed or the nightly count of open issues differed, and `failing` after three failed reconciles in a row. A failing collector stops its scheduled reads until a person runs `sync_work_collector`. A paused collector keeps each webhook delivery and fetches nothing.
