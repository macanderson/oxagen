# refresh_work_order_checks

Read again from GitHub the checks a send's pull request needs on its head commit, and record the required checks and each conclusion. A person who may accept work calls it from the work item's page.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/orders/checks/refresh`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused.
- Roles: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The work item's `wi_…` id |
| `work_order_id` | `string` | The send's `wo_…` id |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the write. Name `version` on the next decision |
| `repeat` | `boolean` | True when the action was already recorded as asked and nothing changed |
| `head_sha` | `string \| null` | The head commit the read was for, or null when the send has no pull request yet |
| `required_checks` | `string[] \| null` | The checks the base branch requires on the head. Null when Oxagen could not read them |
| `unread_reason` | `string \| null` | Why the required checks could not be read, when they could not |

## Semantics

Oxagen reads the checks the base branch requires, from branch protection and rulesets, and each check's latest conclusion on the head. It records a required list only when both reads succeeded. A failed read never stands in for "no check is required", which would open Accept on ticks alone. A failed read is an answer, not an error: `required_checks` is null and `unread_reason` says why.

The facts are GitHub's, never the caller's, so the input names no version and no head commit. A read that finds nothing new records nothing and answers `repeat: true`. It takes the role [accept_work_order](work.order.accept.md) takes, and Accept makes the same read at the press.

A refusal answers with a code:

- `conflict` (409) carries the reason `stale_version` when another write changed the item while this one ran. Read again.
- `not_found` (404): the workspace has no such work item, or the item has no such send.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, or holds no role the action takes.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-251](../adr/ADR-251-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions.
