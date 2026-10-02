# reopen_work_item

Reopen a closed or done work item with a reason. Its history stays, and its brief goes back to a draft.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/items/reopen`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused.
- Roles: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The work item's `wi_…` id |
| `version` | `int` | The item version the person read, 0 or more |
| `reason` | `string` | 1 to 2,000 characters after trimming. Kept with the decision |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the write. Name `version` on the next decision |
| `repeat` | `boolean` | True when the action was already recorded as asked and nothing changed |

## Semantics

Every earlier fact stays in the item's history. The item moves to its next revision, and its brief goes back to a draft that needs a new approval. The next send is a fresh delivery on that newly approved revision.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `stale_version`: the item changed since the version the person read. Read the item again.
  - `not_allowed`: the item is neither closed nor done.
- `not_found` (404): the workspace has no such work item.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, or holds no role the action takes.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-250](../adr/ADR-250-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions and [ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md) for the work records.
