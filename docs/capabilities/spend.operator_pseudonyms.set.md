# set_operator_pseudonyms

An org Owner or Admin turns the operator pseudonyms of the active workspace on or off. With the setting on, [`get_operator_ranking`](spend.operator_ranking.md) shows a pseudonym in place of each operator's name. The ranks, the unproductive spend, and the share of the total stay. Each operator's unproductive share, run count, and runs are withheld, because each could match a pseudonym to a name on the operator rollup.

In the app, the switch sits beside the Operator ranking heading on Spend › By operator.

**Surfaces:** api

## Mode

**sync**

## Surface

- API: `PUT /v1/:org_slug/:workspace_slug/spend/operators/pseudonyms`
- Authentication: session (org Owner or Admin)
- Capability name: `set_operator_pseudonyms`
- Not billed (`noBillingGate: true`). IAM default-deny; high sensitivity. The handler asserts the role itself.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `enabled` | boolean | yes | true turns pseudonyms on |

## Output

| Field | Type | Description |
|---|---|---|
| `pseudonyms` | boolean | the setting as stored |

## Storage

The setting lives in `workspace.operator_ranking_policy`, one row per workspace. No row means the setting is off. The row's salt is written once when the row is created and is never returned or changed, so each operator keeps one pseudonym when the setting goes off and on again.

Each change writes a `capability.invoke_allowed` security event with the acting person and `{ feature: "operator_ranking", change: "pseudonyms", enabled }`. The setting and its event commit in one transaction, so a change with no event rolls back and returns an error.
