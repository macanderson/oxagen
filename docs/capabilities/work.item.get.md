# get_work_item

Read one work item with its source revisions, triage, brief revisions, sends, pull request checks, acceptance, cost, and history.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/items/get`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: a signed-in session or an API key.
- Roles: org Owner or Admin, or workspace Owner, Member, or Viewer, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `string` | The workspace number, such as `WI-12`, or the public id, such as `wi_0a1b2c`. 1 to 64 characters |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | row | The list row ([list_work_items](work.items.list.md)), with `description`, `source_revisions`, and `collector` |
| `triage` | object | The triage view with every correction in force, where triage stands, the decision's model and time, the latest run's failure, a person's override while it is in force, and every correction |
| `brief` | object | The brief's `state`, every saved revision oldest first, triage's drafted criteria, and the repository a new revision starts with |
| `next_send` | `{ send, key }` or `null` | The number and key the next send must carry |
| `sends` | send[] | Every send, newest first |
| `history` | entry[] | Every fact, by item revision and then time |
| `viewer` | `{ can_control, can_approve }` | What the caller's roles let them do. Both are false for an API key and an agent run |

The item's extra fields:

| Field | Type | Notes |
| --- | --- | --- |
| `description` | `string` or `null` | The source's description. It comes from outside the workspace, so show it as text |
| `source_revisions` | revision[] | Each reading of the source: `revision`, `at`, `kind` (`collected`, `entered`, or `changed`), `subject`, `description`, and `labels` |
| `collector` | `{ name, health }` or `null` | The collector that brought the item in. Null for an item a person entered |

Each send:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `send`, `key`, `delivery`, `no_answer`, `agent`, `runtime` | | As in a list row's send |
| `ended` | `boolean` | The send is over, so another may start |
| `item_revision`, `brief_revision`, `brief_digest` | | The item revision and the brief the send went out with |
| `host` | `{ name, last_poll_at }` or `null` | The host the work order went to, and when it last polled |
| `operator` | `string` or `null` | The name of the person who sent it |
| `mandate_id` | `string` or `null` | The agent's mandate at send (`mnd_…`). The work item adds no authority |
| `requested_at`, `delivered_at`, `claimed_at`, `first_run_at`, `run_ended_at` | `string` or `null` | When each step happened |
| `rejected`, `withdrawn`, `stop_requested`, `returned` | object or `null` | The reason, and who and when where a person acted |
| `stopped_at` | `string` or `null` | When the runtime confirmed the stop |
| `runs` | `{ id, cost, basis, tier }[]` | Each run, with its cost, how it was measured, and its tier. `cost` is null when the run reported no usage or has not been rolled up |
| `cost` | `{ runs, known_runs, total }` | As in a list row, over this send's runs |
| `pull_request` | object or `null` | The repository, number, link, head, when the head was seen, the merge, and when it closed without merging, from the send's facts. `url` is the forge store's link when the store holds the same pull request |
| `pull_requests` | pull request[] | Every pull request the send has in the forge store, newest first, as in a list row's send |
| `required_checks` | `string[]` or `null` | The checks the base branch requires on the head. Null until Oxagen reads them |
| `checks` | `{ name, conclusion, required }[]` | Each check's latest result on the head |
| `earlier_checks` | `{ head, checks }` or `null` | The latest results on the head before this one. They decide nothing on the current head |
| `checks_word`, `gate` | | As in a list row's send |
| `acceptance` | object or `null` | A person's acceptance of the current head: who, when, the criteria ticked, and the checks required then |
| `stale_acceptance` | object or `null` | An acceptance on an earlier head. It counts for nothing and stays visible |
| `claims` | object[] | The agent's claims on criteria. Nothing records one in Phase 1 yet |

Each history entry names its `kind`, its `source`, who acted by display name, when, the item revision, the send number, and the details the fact carries: a reason, a resolution, an outcome, a head, a check and its conclusion, a pull request, a merge commit, and a brief revision.

## Semantics

The answer is read from the item's records and reduced from its facts on the server ([ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md)). The item is found only in the caller's workspace. A deleted item reads as missing. A read never calls GitHub, and [refresh_work_order_checks](work.order.checks.refresh.md) reads GitHub again. Each send's `pull_requests` and the link in its `pull_request` come from the forge store ([ADR-292](../adr/ADR-292-every-pull-request-read-comes-from-the-forge-store.md)). The head, the checks, the merge, and the acceptance come from the send's facts.

Names are display names. A person shows as the name they gave, or their email when they gave none. A host's fact shows the host's name. Oxagen's and the provider's facts name nobody.

The brief's `state` is:

- `none`: no saved brief, and triage drafted no criteria.
- `triage_draft`: no saved brief, and triage drafted criteria.
- `draft`: a saved revision waits for approval on the current item revision.
- `approved`: the current item revision has an approved brief.
- `out_of_date`: the item changed after approval, or a running send went out on an earlier revision.

`next_send` is set when the current revision has an approved brief, no send is open, and the item is neither done nor closed. Send it with [send_work_order](work.order.send.md). Its key stays the same on a retry.

A refusal answers with a code:

- `not_found` (404), reason `work_item_not_found`: the workspace has no such item, or the item was deleted.
- `forbidden` (403): the caller holds no role this read takes.
- `invalid_input` (400): a stored brief does not read as work-brief/v1.
- A body that does not match the input answers 400 before the handler runs.
