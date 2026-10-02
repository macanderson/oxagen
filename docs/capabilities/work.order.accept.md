# accept_work_order

Accept a send's result on the pull request's exact head commit, with every criterion ticked. Acceptance merges nothing.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/orders/accept`, returns 200
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
| `head_sha` | `string` | The head commit the person reviewed, 40 lowercase hex characters |
| `brief_digest` | `string` | The approved brief's `sha256:` digest |
| `criteria` | `string[]` | Up to 40 criterion ids the person ticked, such as `c1` |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the write. Name `version` on the next decision |
| `repeat` | `boolean` | True when the action was already recorded as asked and nothing changed |
| `order` | `{ id, send, key, delivery }` | The send after the write |
| `required_checks` | `string[]` | The checks the base branch required on the head when the person accepted. Empty when none |

## Semantics

Oxagen reads from GitHub, at the press, the checks the base branch requires on the head and each check's latest conclusion. It records what it read, and that record stays even when the acceptance is refused. A required check that is missing, failing, cancelled, skipped, or unread blocks the acceptance. When the base branch requires no check, the acceptance rests on the person's tick for every criterion and names the head commit.

Acceptance merges nothing. The item is done once the pull request merges too, in either order. A new head commit voids the acceptance. An acceptance on the same head and brief that is already recorded changes nothing and answers `repeat: true`.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `stale_version`: the item changed since the version the person read. Read the item again.
  - `stale_head`: the pull request's head is no longer the commit the person reviewed. Review the new head.
  - `stale_brief`: the digest is not the approved brief, or the item moved to a revision whose brief is not approved yet.
  - `not_allowed`: Oxagen could not read the required checks, a required check did not pass or has not reported, a criterion is not ticked, the run has not ended, the send is over or already accepted on another head, the send has no pull request or head yet, the pull request closed without merging, or the item is closed or done.
- `invalid_input` (400): a ticked criterion id is not in the approved brief.
- `not_found` (404): the workspace has no such work item, or the item has no such send.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, or holds no role the action takes.
- A body that does not match the input answers 400 before the handler runs.

[refresh_work_order_checks](work.order.checks.refresh.md) makes the same read without accepting. See [ADR-251](../adr/ADR-251-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) and oxageninc/roadmap#279.
