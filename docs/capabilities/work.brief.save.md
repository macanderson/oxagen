# save_work_brief

Save a new revision of a work item's acceptance brief. The brief names the repository the work changes and the criteria a reviewer checks.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/items/brief/save`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused.
- Roles: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The work item's `wi_…` id |
| `version` | `int` | The item version the person read, 0 or more |
| `item_revision` | `int` | The item revision the editor read, 1 or more |
| `repository` | `string` | The GitHub repository the work changes, as owner/name |
| `criteria[]` | `{ id?, text, tag, intent, evidence?, provenance }` | 1 to 40 criteria. See the criterion fields below |

A criterion has these fields:

- `id`: the criterion's `c1`, `c2` … id from an earlier revision, to keep it. Leave it out for a new criterion, which takes the next unused number.
- `text`: what a reviewer checks, 1 to 2,000 characters.
- `tag`: `code`, `test`, `docs`, or `review`.
- `intent`: `check` or `review`, which says how a reviewer settles it.
- `evidence`: optional text, up to 1,000 characters.
- `provenance`: `source`, `triage`, or `person`, which says where it came from.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the write. Name `version` on the next decision |
| `repeat` | `boolean` | True when the action was already recorded as asked and nothing changed |
| `brief` | `{ revision, digest }` | The new brief revision and its `sha256:` digest |

## Semantics

Each save writes a new brief revision. A saved brief never changes. Editing an approved brief moves the item to its next revision, so the item leaves `ready` until a person approves the new brief.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `stale_version`: the item changed since the version the person read. Read the item again.
  - `stale_revision`: the item is at another revision than `item_revision`.
  - `not_allowed`: the item is closed or done. Reopen it first.
- `invalid_input` (400): a criterion names an id the item never issued, two criteria share an id, or the repository is not owner/name.
- `not_found` (404): the workspace has no such work item.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, or holds no role the action takes.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-250](../adr/ADR-250-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions and [ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md) for the work records.
