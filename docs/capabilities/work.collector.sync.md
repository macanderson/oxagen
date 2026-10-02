# sync_work_collector

Queue a reconcile of one work collector now, even while it is failing (lane P1-03, #5103). Use it after reconnecting GitHub.

**Surfaces:** api, mcp

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/collectors/sync`, returns 202
- MCP: `sync_work_collector`
- Authentication: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `collector_id` | `uuid` | |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `collector_id` | `uuid` | |
| `queued` | `true` | |

## Semantics

The reconcile reads every issue changed since the collector's cursor, one page at a time. It moves the cursor only after a page is stored, so a read that fails partway loses nothing it can read again. A reconcile that finishes moves a failing collector back to healthy, or to lagging when it found changes a webhook missed. One check runs at a time per collector. A paused collector answers 409: resume it with `set_work_collector`, which also reads it at once.
