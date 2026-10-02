# get_work_order_metrics

The operator metrics, the work order metrics, and unassigned spend of the active workspace, for each week that overlaps a day range (spend spec, Operator productivity). A manager reads it to see what each operator's agents finished, what that cost, and how much spend had no work item behind it. Each figure names its definition and cites the work orders and runs behind it. The answer reports the record and gives no verdict on the person.

**Surfaces:** api, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/work-order-metrics`
- Authentication: session (org Owner or Admin), the people who read [`get_operator_ranking`](spend.operator_ranking.md), because the answer names operators
- Capability name: `get_work_order_metrics`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity. The handler asserts the role itself and refuses anyone else with `forbidden` (`org_role_required`). In an Enterprise org, migration `20261002080000_backfill_work_order_metrics_grants.sql` grants the capability to the system org Owner and Admin roles of every org that existed before it did.
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `period` | object | yes | `{ from, to }`, UTC days, `to` on or after `from`, at most 92 days (`SPEND_RANGE_DAYS_MAX`) |

## Output

| Field | Type | Description |
|---|---|---|
| `period` | object | as asked |
| `pseudonyms` | boolean | true when the workspace's pseudonym setting is on and each operator row carries a pseudonym |
| `currency` | string | the one currency every money figure is in |
| `definitions` | object | `{ operator, workOrder, unassigned }`: each metric's `id`, `name`, `definition`, and `direction` |
| `weeks` | object[] | each week that overlaps the period, oldest first, at most 14 |

A week runs Monday 00:00 UTC to the next Monday and is reported whole, even where the period starts or ends inside it. Each week:

| Field | Type | Description |
|---|---|---|
| `week` | object | `{ from, to }`: the Monday and the Sunday |
| `settled` | boolean | true once a day has passed since the week ended. Until then a direct work order can still be attached inside its grace window and move spend off the unassigned line |
| `workspace` | object | `{ spend, unproductive, unassigned, notRecorded, workOrders }` for the whole workspace |
| `operators` | object[] | `{ operator, metrics, unassigned, workOrders }` for every operator with a run or a work order in the week, ordered by key or by pseudonym |
| `agents` | object[] | `{ agentKey, unassigned, workOrders }` for every agent with a run or a work order in the week |

`workspace.unproductive` is the week's unproductive spend, the count [`get_unproductive_spend`](spend.unproductive.md) gives for the same days. Unassigned spend is never part of it. `workspace.notRecorded` is the spend on runs rolled up before Oxagen recorded each run's work order, which have no work order until they are rolled up again.

Every figure carries the work orders (`workOrders`, `wo_…`) and the runs (`runs`) behind it, at most ten of each.

## Operator metrics

Per operator, per week. Each covers the work orders the operator sent and the direct work orders Oxagen opened for the operator's runs. `metrics` holds one field per metric, named by its id in camel case.

### done_work_orders

Work orders whose definition of done passed. A work order counts in the week of its first passing check run. Only a work order sent from Oxagen has a definition of done, so a direct work order is never done.

### cost_per_done

Spend on work orders with a definition of done, divided by done work orders. Null when nothing was done.

### unproductive_share

Unproductive spend divided by all spend, each frame counted by the time it ran. This is the guardrail on growth. Null under pseudonyms.

### agents_in_flight

Distinct agents with a run open, averaged over the week. Two runs of one agent at once count it once. For the current week, the average covers the part of the week that has passed.

### leverage

Done work orders divided by agents in flight. Null when no agent was in flight.

### touches_per_done

Interrupts divided by done work orders. `basis` is `interrupts`: no detector classifies corrective prompts yet, so the figure counts interrupts on every workspace. An interrupt is a prompt that stopped the agent mid-message, which only harnesses that report it record. Null when nothing was done.

### unassigned_share

Unassigned spend divided by all spend. Null under pseudonyms.

## Work order metrics

For the work orders with a definition of done, grouped by operator, by agent, and for the workspace. `done` is the week's done work orders.

### done_rate

Work orders closed in the week whose definition of done passed by the close, divided by work orders closed in the week.

### first_pass_rate

Done work orders with no failed check run before the passing one, divided by done work orders. A pending check run is not a failure.

### cost_to_done

Spend on every run of a work order that started by its passing check, averaged over done work orders. Each run adds its whole cost.

### time_to_done

Time from dispatch to the passing check, averaged over done work orders, in milliseconds.

### rework_spend

Spend on runs that started after a failed check run, up to the passing one.

### abandoned_spend

Spend on work orders closed in the week with no passing check run.

### reopen_rate

Done work orders whose work item a person reopened, or that a person returned, within 14 days of the passing check, divided by done work orders. `pending` counts the done work orders whose 14 days have not ended.

## Unassigned spend

### unassigned_spend

Spend on runs whose direct work order has no work item, with its tokens and its share of all spend. A direct work order attached to a work item within 24 hours of its first run counts as assigned from that run. One attached later counts as assigned from the attachment on, so the frames before the attachment stay unassigned. The 24-hour window is the same for every workspace.

Unassigned spend shows on its own line. It never adds to unproductive spend, because a run with no work item can still be useful work.

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | `org_role_required` | the caller is not an org Owner or Admin |
| `conflict` | `work_order_metrics_mixed_currency` | the period's spend is priced in more than one currency; each figure sums one currency, so none is built |

## Counting

Spend and unassigned spend count each frame by the time it ran, as the operator ranking's shares do. A run whose frames all fall inside one week, and on one side of the instant its direct work order counts as assigned from, adds its whole cost. Any other run is priced frame by frame from the frame store. At most 50 such runs are read, largest first. A figure that needs a run left unread is null.

Cost to done, rework spend, and abandoned spend add whole runs of each work order, chosen by when each run started against the work order's check runs.

## Pseudonyms

With the workspace's pseudonym setting on, a pseudonym replaces each operator's name, as in [`get_operator_ranking`](spend.operator_ranking.md). Each operator row keeps its counts and drops its work orders, runs, and agents, its unproductive and unassigned shares, and its unassigned spend and tokens. Any of those could match a pseudonym to a name on a page that names operators.
