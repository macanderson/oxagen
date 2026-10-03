# list_work_items

List the workspace's work items. Each row gives the item's state, what it waits for, its latest send with the required checks on its pull request, and what its runs cost.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/items/list`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: a signed-in session or an API key.
- Roles: org Owner or Admin, or workspace Owner, Member, or Viewer, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `limit` | `int` | The most items to answer, 1 to 500. The default is 500 |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `items` | row[] | The newest `limit` items by their last change. Deleted items are left out |
| `truncated` | `boolean` | True when the workspace holds more items than `limit` |
| `viewer` | `{ can_control, can_approve }` | What the caller's roles let them do on the Work pages. Both are false for an API key and an agent run |

Each row:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The item's `wi_…` id |
| `number` | `string` | The workspace's number for the item, such as `WI-19` |
| `title` | `string` | The source's subject. It comes from outside the workspace, so show it as text |
| `origin` | `provider`, `email`, `slack`, `csv`, or `manual` | Where the item came from |
| `source_url` | `string` or `null` | The source's link |
| `repository` | `string` or `null` | The repository the item came from, as `owner/name` |
| `requester` | `string` or `null` | The requester as the source named them |
| `labels` | `string[]` | The source's labels |
| `arrived_at` | `string` | When Oxagen first stored the item |
| `finished_at` | `string` or `null` | When the item was done or closed. Null while it is open |
| `state` | item state | `new`, `held`, `triaged`, `needs_info`, `changed`, `ready`, `sent`, `running`, `review`, `done`, or `closed` |
| `status` | status | The word beside the item's dot. See Status |
| `tab` | `inbox`, `running`, `review`, or `done` | The Work page tab the item sits on |
| `version` | `int` | Name this version on the next action |
| `revision` | `int` | The item revision |
| `priority` | `{ label, by, reason, cites, set_by }` | Triage's priority, or a person's correction with the person's name |
| `wait` | `{ kind, … }` | What the item waits for. See Wait |
| `send` | object or `null` | The latest send since the last reopen. See Send |
| `cost` | `{ runs, known_runs, total }` | What the item's runs cost. See Cost |

## Semantics

Each row is reduced from the item's facts on the server ([ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md)). A read never calls GitHub. The checks are what Oxagen last recorded, and [refresh_work_order_checks](work.order.checks.refresh.md) reads GitHub again.

### Tab

New, held, triaged, needs_info, changed, and ready items are in the inbox. Sent and running items are on the running tab. Items in review are on the review tab. Done and closed items are on the done tab.

### Status

| Status | When |
| --- | --- |
| `triaging` | The item is new and triage has not decided |
| `triage_failed` | The item is new and the latest triage run failed |
| `needs_info` | Triage asked a question |
| `possible_duplicate` | The item is held as a possible duplicate |
| `out_of_scope` | The item is held as out of scope |
| `brief_to_approve` | The item is triaged and its brief waits to be written or approved |
| `changed` | The source or the approved brief changed after approval |
| `ready` | The brief is approved and the item can be sent |
| `send_rejected` | The item is ready again because the host rejected the latest send |
| `waiting_for_claim` | The send waits for its host to take the work order |
| `no_answer` | The host took the work order and has not claimed it |
| `running` | The host claimed the send, or its run is going |
| `stopping` | A person asked the run to stop |
| `in_review` | The run ended, or the pull request merged or closed |
| `accepted` | A person accepted the pull request's current head, and it has not merged |
| `done` | The work was accepted and merged |
| `closed` | A person closed the item |

A host has taken the work order when Oxagen recorded the delivery, or when the order's `work_order` command reads `sent` or `received`.

### Wait

`wait.kind` says what the item waits for, and the other fields carry the facts a page needs to say it: a triage question, a person's name and reason, a runtime name and the host's last poll, a head commit, or a check name. Every name is a display name and every time is an ISO 8601 string. The contract lists every kind in `workWaitSchema` (`packages/oxagen/src/contracts/work.read.shared.ts`).

### Send

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The send's `wo_…` id |
| `send` | `int` | The send number |
| `key` | `string` | `<item>:r<brief revision>:s<send>` |
| `delivery` | delivery state | Where the send stands with its runtime |
| `no_answer` | `boolean` | The host took the work order and has not claimed it |
| `agent` | `{ id, name, harness }` | The agent it went to. Every field is null when the agent is gone |
| `runtime` | `{ name, tier }` | The runtime's name and the tier the send recorded |
| `requested_at` | `string` | When the person sent it |
| `pull_request` | `{ repository, number, url, head }` or `null` | The pull request the run linked, from the send's facts. Acceptance, the checks, and the gate are judged on its head. `url` is the forge store's link when the store holds the same pull request |
| `pull_requests` | pull request[] | Every pull request the send has in the forge store, newest first. Empty when the store holds none |
| `checks` | checks word | The required checks on the head, as one word |
| `gate` | `{ open, block, detail }` | Whether Accept is open, and if not, why |
| `accepted` | `boolean` | A person accepted the pull request's current head |

Each entry in `pull_requests` comes from the forge store ([ADR-292](../adr/ADR-292-every-pull-request-read-comes-from-the-forge-store.md)):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The forge store's `fpr_…` id |
| `provider` | `github` or `gitlab` | The forge |
| `repository` | `string` | Lower-cased owner/name, or the GitLab project path |
| `number` | `int` | The pull request number, or the merge request iid |
| `url` | `string` | The link the forge reported |
| `title` | `string` or `null` | The title the forge last reported. Render it as text |
| `state` | `open`, `draft`, `closed`, or `merged` | The state the forge last reported |
| `head` | `string` | The head commit the forge last reported |
| `state_seen_at` | `string` | When Oxagen last read the state |

A send reaches a pull request through the forge store's work order link, or through its `pr_linked` fact matched to a forge row by repository and number. A pull request the store holds no row for is not listed until its next delivery or the backfill records it.

The checks word is `passing` when every required check passed, `failing` when one failed, was cancelled, was skipped, or timed out, `missing` when one has not reported, and `running` when one is still running. A failure outranks a check that has not reported, which outranks one still running. It is `unread` when Oxagen has not read the required checks for this head, `none_required` when the base branch requires none, `no_pull_request` when the run linked none, and `pr_closed` when the pull request closed without merging.

### Cost

`runs` counts every run linked to any of the item's sends. `known_runs` counts the runs whose cost the spend rollup recorded. `total` sums those costs as integer micros and a currency. It is null when no cost is known or when the known costs are in different currencies. A run with no recorded cost is never counted as zero.

A refusal answers with a code:

- `forbidden` (403): the caller holds no role this read takes.
- A body that does not match the input answers 400 before the handler runs.

[get_work_item](work.item.get.md) reads one item with everything a person decides on.
