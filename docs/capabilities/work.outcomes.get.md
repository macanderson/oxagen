# get_work_outcomes

Count the workspace's work accepted and merged, returned, and closed in a window of days, with lead time, review touches, cost coverage, reopens, and reverts.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/outcomes/get`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: a signed-in session or an API key.
- Roles: org Owner or Admin, or workspace Owner, Member, or Viewer, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `days` | `int` | The window, 7 to 90 days back from now. The default is 30 |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `days` | `int` | The window asked for |
| `since` | `string` | When the window starts |
| `accepted_merged` | `int` | Distinct work items accepted and merged in the window. An item counts once, however many of its sends finished |
| `returned` | `int` | Sends a person returned in the window |
| `closed` | `{ cancelled, declined, duplicate }` | Closes in the window, by resolution |
| `lead_time` | `{ median_hours, p90_hours, sample }` | From the first source reading to done, over the accepted items |
| `touches` | object | A person's decisions on the accepted items, and the touches per item |
| `cost` | `{ runs, known_runs, total }` | What the accepted items' runs cost |
| `reopens` | `{ cohort, reopened, waiting }` | Reopens of items that finished 30 or more days ago |
| `reverts` | `{ cohort, reverted, waiting }` | Reverts of the same items. `cohort` and `waiting` equal the ones in `reopens` |
| `delivery` | `{ sends, claimed, rejected, withdrawn, waiting, claim_minutes, truncated }` | The sends a person made in the window, each in one bucket, and the minutes from send to claim |
| `truncated` | `boolean` | True when more items finished than one read counts |
| `weeks` | `{ week, accepted_merged, returned, median_lead_hours, entered, sent, full_flow, complete }[]` | Each UTC week from Monday that overlaps the window |

## Semantics

Every figure is counted from the work records ([ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md)). None is estimated, and none names a person: the figures describe the workflow.

- An item is done when it is both accepted and merged. Its done time is the later of the two. An item counts as accepted and merged when its done time falls in the window. `accepted_merged` counts work items, not sends. An item done twice in the window, around a reopen, counts once, in the week of its latest done time. So within one read, the weeks' `accepted_merged` add up to the window's.
- Accepted and merged, returned, and closed are separate counts. They never add up into one rate.
- Lead time runs from the item's first source reading, collected or entered, to its done time. The median and the 90th percentile use the nearest rank: the value at position ceil(p × n) of the sorted sample. Both are null with no sample. A lead time that would run backwards, because the provider's clock and Oxagen's disagree, is left out of the sample.
- Review touches count brief approvals, acceptances, returns, triage overrides, and triage corrections on the accepted items, over their whole life. `per_item` divides the total by the accepted items, and is null with none.
- Cost sums the runs linked to the accepted items' sends whose cost the spend rollup recorded. A run with no recorded cost adds nothing and stays unknown. The total is null when no cost is known or the known costs are in different currencies. In-app triage spend is not here. It shows on Billing.
- The reopen cohort is the items whose done time falls 30 to 30 plus `days` days ago. An item reopened when a reopen follows its done time. `waiting` counts the items done in the last 30 days, which wait to count.
- Reverts count over the same cohort, with the same `waiting`. An item counts as reverted when GitHub merged a pull request whose description has the line `Reverts <owner>/<repo>#<n>`, where `<n>` is the pull request that finished the item. GitHub's Revert button writes that line. Oxagen reads the line when the revert merges, so a later edit of the description changes nothing. A revert made by hand without that line is not counted, and neither is a line that names a pull request in another repository. A revert of the revert does not clear it.
- A revert never moves an item out of done. The revert shows in the item's history, and a person decides whether to reopen the item.
- A week's median lead time covers the items done in that week.
- Delivery puts each send a person made in the window in one bucket. A send the runtime or Oxagen rejected is `rejected`. Otherwise, a send a runtime claimed is `claimed`, even when a person withdrew it later, because the runtime received it. Otherwise, a send a person withdrew is `withdrawn`, and the rest are `waiting`. The four buckets add up to `sends`.
- `claim_minutes` runs from each claimed send to the runtime's first claim. The median and the 90th percentile use the nearest rank, as lead time does, and both are null with no sample. A claim time that would run backwards is left out of the sample.
- A week's `entered` counts the items Oxagen created that week, collected from a provider or entered by a person. It reads when the item's row was created, not the provider's last update, so a backlog imported this week counts this week. Its `sent` counts the sends a person made that week. The database counts both, so neither stops at a cap.
- A week's `full_flow` is true when at least one item was accepted and merged in that week.
- A week's `complete` is true when the window covers all of it, from Monday 00:00 to Sunday 23:59:59.999 UTC. The oldest week is cut when the window starts after its Monday midnight, and the newest week is still running. Both read `complete: false`, and their counts cover only part of a week. A read of `{"days": 35}` made on a Monday holds the four whole weeks before it.
- One read counts at most 2,000 items and 2,000 sends, newest first. `truncated` is true when more items could count, and `delivery.truncated` when more sends were made. The figures then cover the newest ones.

A refusal answers with a code:

- `forbidden` (403): the caller holds no role this read takes.
- A body that does not match the input answers 400 before the handler runs.

## Pilot measures

Delivery and the weekly `entered`, `sent`, `full_flow`, and `complete` figures are the pilot measures from `agent-work-phase-1.html` in `oxageninc/roadmap` (Release gates). They show whether a team used the full flow in a week, how much work it entered and sent, and whether its runtimes received the sends. No figure here decides the pilot. A person reads the figures and decides.
