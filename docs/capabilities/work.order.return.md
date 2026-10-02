# return_work_order

Return a send's result to the agent with a reason. By default the item goes out again to the same agent as a new send.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/orders/return`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused.
- Roles: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The work item's `wi_…` id |
| `version` | `int` | The item version the person read, 0 or more |
| `work_order_id` | `string` | The send's `wo_…` id |
| `reason` | `string` | 1 to 2,000 characters after trimming. Kept with the decision |
| `resend` | `boolean` | Default true. Send the item again to the same agent. False leaves it ready |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the write. Name `version` on the next decision |
| `repeat` | `boolean` | True when the action was already recorded as asked and nothing changed |
| `order` | `{ id, send, key, delivery }` | The send after the write |
| `resent` | `{ id, send, key, delivery } \| null` | The new send, or null when none went out |
| `resend_refused` | `string \| null` | Why no new send went out, when `resend` asked for one |

## Semantics

The send ends as `returned`. With `resend`, the item goes out again to the same agent as a new send, and the new run's first prompt carries the reason. A new send checks the same rules as [send_work_order](work.order.send.md), so Oxagen reads the workspace's governance mode first. When the agent cannot take the new send now, the return still stands, the item waits in `ready`, and `resend_refused` says why. That case is an answer, not an error.

Phase 1 returns work only after the run ended, or after the pull request merged or closed. A return of a send that is already returned changes nothing and answers `repeat: true`.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `stale_version`: the item changed since the version the person read. Read the item again.
  - `not_allowed`: the send is over, or its run has not ended and its pull request is still open. Stop the run first. The same reason answers when `resend` is true and Oxagen could not read the governance mode.
- `not_found` (404): the workspace has no such work item, or the item has no such send.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, or holds no role the action takes.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-251](../adr/ADR-251-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions and [ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md) for the work records.
