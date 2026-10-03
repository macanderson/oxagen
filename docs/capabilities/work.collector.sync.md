# sync_work_collector

Queue a reconcile of one work collector now, even while it is failing (lane P1-03, #5103). Use it after reconnecting GitHub.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/collectors/sync`, returns 202
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused before anything is read.
- Roles: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`

A sync changes a collector: it forces a reconcile and can move a failing collector back to its schedule. Only a person changes a collector ([ADR-250](../adr/ADR-250-phase-1-work-intake-reads-github-through-the-github-app-and-triage-cites-a-steering-record.md), #5181). An agent on its operator's machine can read the operator's `oxagen login` key, so every API key is refused.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `collector_id` | `uuid`, optional | The collector's row id |
| `name` | `string`, optional | The collector's name, unique in the workspace |

Name the collector by exactly one of the two. A call with neither or both answers 400.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `collector_id` | `uuid` | |
| `queued` | `true` | |

## Semantics

The reconcile reads every issue changed since the collector's cursor, one page at a time. It moves the cursor only after a page is stored, so a read that fails partway loses nothing it can read again. A reconcile that finishes moves a failing collector back to healthy, or to lagging when it found changes a webhook missed. One check runs at a time per collector. Requests to sync one collector in the same minute queue one reconcile. A paused collector answers 409: resume it with `set_work_collector`, which also reads it at once.

Errors: 400 for a call that names no collector or names it twice, 403 for an API key or an agent run (`person_required` or `agent_run`) and for a caller without the role, 404 for a collector the workspace does not hold, 409 for a paused collector.
