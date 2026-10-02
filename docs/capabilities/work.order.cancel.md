# cancel_work_order

Withdraw a send that no runtime has claimed. The send ends at once and no run starts.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/orders/cancel`, returns 200
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

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the write. Name `version` on the next decision |
| `repeat` | `boolean` | True when the action was already recorded as asked and nothing changed |
| `order` | `{ id, send, key, delivery }` | The send after the write |

## Semantics

The send's delivery becomes `withdrawn` and its `work_order` command is cancelled. A claim the host makes after this is refused, so no run starts. A send a runtime already claimed is stopped with [stop_work_order](work.order.stop.md) instead. Withdrawing a send that is already withdrawn changes nothing and answers `repeat: true`.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `stale_version`: the item changed since the version the person read. Read the item again.
  - `not_allowed`: a runtime already claimed the send, or the send is over. Stop the run instead.
- `not_found` (404): the workspace has no such work item, or the item has no such send.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, or holds no role the action takes.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-250](../adr/ADR-250-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions and [ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md) for the work records.
