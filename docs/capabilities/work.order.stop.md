# stop_work_order

Ask the runtime to stop the run a send started. The send reads `stopped` once the runtime confirms.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/orders/stop`, returns 200
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
| `command_id` | `string \| null` | The `cancel` command queued to the run (`tcm_…`), or null when no run is linked yet |

## Semantics

Oxagen records the request and queues a `cancel` to the run, which its host carries. The send reads `stopping` until the runtime confirms, and `stopped` once it does. A stop that lands before the run is linked reaches the run when it links, so `command_id` is null then. Commits and the pull request stay where they are. A stop on a send that is already stopping or stopped changes nothing and answers `repeat: true`.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `stale_version`: the item changed since the version the person read. Read the item again.
  - `not_allowed`: the send is over, no runtime has claimed it (withdraw it instead), or its run has ended (return or accept the work).
- `not_found` (404): the workspace has no such work item, or the item has no such send.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, or holds no role the action takes.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-250](../adr/ADR-250-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions and [ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md) for the work records.
