# get_work_outcomes

Count the workspace's work accepted and merged, returned, and closed in a window of days, with lead time, review touches, cost coverage, and reopens.

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
| `accepted_merged` | `int` | Items accepted and merged in the window |
| `returned` | `int` | Sends a person returned in the window |
| `closed` | `{ cancelled, declined, duplicate }` | Closes in the window, by resolution |
| `lead_time` | `{ median_hours, p90_hours, sample }` | From the first source reading to done, over the accepted items |
| `touches` | object | A person's decisions on the accepted items, and the touches per item |
| `cost` | `{ runs, known_runs, total }` | What the accepted items' runs cost |
| `reopens` | `{ cohort, reopened, waiting }` | Reopens of items that finished 30 or more days ago |
| `weeks` | `{ week, accepted_merged, returned, median_lead_hours }[]` | Each UTC week from Monday that overlaps the window |

## Semantics

Every figure is counted from the work records ([ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md)). None is estimated, and none names a person: the figures describe the workflow.

- An item is done when it is both accepted and merged. Its done time is the later of the two. An item counts as accepted and merged when its done time falls in the window. An item done twice in the window, around a reopen, counts once.
- Accepted and merged, returned, and closed are separate counts. They never add up into one rate.
- Lead time runs from the item's first source reading, collected or entered, to its done time. The median and the 90th percentile use the nearest rank: the value at position ceil(p × n) of the sorted sample. Both are null with no sample. A lead time that would run backwards, because the provider's clock and Oxagen's disagree, is left out of the sample.
- Review touches count brief approvals, acceptances, returns, triage overrides, and triage corrections on the accepted items, over their whole life. `per_item` divides the total by the accepted items, and is null with none.
- Cost sums the runs linked to the accepted items' sends whose cost the spend rollup recorded. A run with no recorded cost adds nothing and stays unknown. The total is null when no cost is known or the known costs are in different currencies. In-app triage spend is not here. It shows on Billing.
- The reopen cohort is the items whose done time falls 30 to 30 plus `days` days ago. An item reopened when a reopen follows its done time. `waiting` counts the items done in the last 30 days, which wait to count. Reverts are not recorded.
- A week's median lead time covers the items done in that week.

A refusal answers with a code:

- `forbidden` (403): the caller holds no role this read takes.
- A body that does not match the input answers 400 before the handler runs.
