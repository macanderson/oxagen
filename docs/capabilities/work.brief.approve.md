# approve_work_brief

Approve the latest acceptance brief for a work item's current revision, so the item can be sent to an agent.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/items/brief/approve`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused.
- Roles: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The work item's `wi_…` id |
| `version` | `int` | The item version the person read, 0 or more |
| `item_revision` | `int` | The item revision the person read, 1 or more |
| `brief_revision` | `int` | The brief revision the person approves, 1 or more |
| `brief_digest` | `string` | That brief's `sha256:` digest |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the write. Name `version` on the next decision |
| `repeat` | `boolean` | True when the action was already recorded as asked and nothing changed |

## Semantics

The approval names the brief's digest. An approved brief never changes, so an edit is a new revision that needs its own approval. A repeat of the same approval changes nothing and answers `repeat: true`.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `stale_version`: the item changed since the version the person read. Read the item again.
  - `stale_revision`: the item or the latest brief is at another revision than the person read. Save the brief again for the current revision.
  - `stale_brief`: the brief revision or digest is not the latest brief. Read the brief again.
  - `not_allowed`: the item is closed or done, it has no brief, its revision already has another approved brief, triage has an open question, or triage holds it as a duplicate or out of scope.
- `not_found` (404): the workspace has no such work item.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, or holds no role the action takes.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-250](../adr/ADR-250-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions and [ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md) for the work records.
