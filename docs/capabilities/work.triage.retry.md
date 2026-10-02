# retry_work_triage

Queue triage to run again on one work item (lane P1-03, #5103). Use it after triage recorded a failure on the item, or after the priorities record changed.

**Surfaces:** api, mcp

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/triage/retry`, returns 202
- MCP: `retry_work_triage`
- Authentication: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`. The triage run is charged as in-app assistant spend on the Billing page.
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The `wi_…` id |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | |
| `state` | `string` | The item's state when the run was queued |
| `queued` | `true` | |

## Semantics

The run waits with the workspace's other triage runs, and at most 60 start per workspace per minute. It runs only while the item is new, held, triaged, needs_info, or changed. Otherwise the call answers 409. A person's corrections stay in force whatever the run suggests. Triage asks the model once, and once more after an answer that fails the `triage/v1` check. A second failure is recorded on the item as `triage_failed`.
