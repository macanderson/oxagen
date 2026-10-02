# close_work_item

Close a work item without finishing it, as cancelled, declined, or a duplicate, with a reason. The source issue stays open.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/items/close`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused.
- Roles: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The work item's `wi_…` id |
| `version` | `int` | The item version the person read, 0 or more |
| `resolution` | `string` | `cancelled`, `declined`, or `duplicate` |
| `reason` | `string` | 1 to 2,000 characters after trimming. Kept with the decision |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the write. Name `version` on the next decision |
| `repeat` | `boolean` | True when the action was already recorded as asked and nothing changed |

## Semantics

The item's state becomes `closed`. A send still out must be withdrawn or stopped first. A send whose run ended, or whose pull request merged or closed, does not block the close. Oxagen writes nothing back to the source, so a GitHub issue stays open. Closing an item that is already closed changes nothing and answers `repeat: true`. [reopen_work_item](work.item.reopen.md) brings it back.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `stale_version`: the item changed since the version the person read. Read the item again.
  - `not_allowed`: the item is done (reopen it to change its resolution), or a send is still out.
- `not_found` (404): the workspace has no such work item.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, or holds no role the action takes.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-251](../adr/ADR-251-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions and [ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md) for the work records.
