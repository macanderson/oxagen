# retry_work_triage

Queue triage to run again on one work item (lane P1-03, #5103). Use it after triage recorded a failure on the item, or after the priorities record changed.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/triage/retry`, returns 202
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused before anything is read.
- Roles: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`. The triage run is charged as in-app assistant spend on the Billing page.

Triage runs once per item revision unless a person asks for a retry, and each retry is a model call the organization pays for ([ADR-250](../adr/ADR-250-phase-1-work-intake-reads-github-through-the-github-app-and-triage-cites-a-steering-record.md)). So only a person asks for one. An agent on its operator's machine can read the operator's `oxagen login` key, so every API key is refused.

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

The run waits with the workspace's other triage runs, and at most 60 start per workspace per minute. It runs only while the item is new, held, triaged, needs_info, or changed. Otherwise the call answers 409. A person's corrections stay in force whatever the run suggests. Triage asks the model once, and once more after an answer that fails the `triage/v1` check. A second failure is recorded on the item as `triage_failed`. Requests to retry one item at the same item version queue one run. Each run that records a result or a failure moves the version, so a retry after that run queues a new one.

Errors: 403 for an API key or an agent run (`person_required` or `agent_run`) and for a caller without the role, 404 for an item the workspace does not hold, 409 for an item past triage.
