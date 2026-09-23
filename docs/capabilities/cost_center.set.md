# set_cost_center

Charge the active workspace, or one agent in it, back to a cost-center label, or clear the label (ADR-142). The label must be live on the organization's list. When the rollup next rolls a run up, it reads the agent's label first and the workspace's label second. Runs already rolled up keep the cost center they had.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/:workspace_slug/spend/cost-centers/set`
- MCP: `set_cost_center`
- Authentication: session (org Owner, Admin, or Billing). The handler asserts the org role itself (INV-29).
- Capability name: `set_cost_center`
- Workspace-scoped (`scoped: true`). The workspace in the path is the one written, or the one the agent belongs to.
- Not billed (`noBillingGate: true`). IAM default-deny, medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `target` | enum | yes | `workspace` or `agent` |
| `agent` | string | when `target` is `agent` | the agent's slug in this workspace |
| `costCenter` | string or null | yes | a live label on the organization's list, or `null` to clear |

The match against the list ignores case. The handler stores the list's spelling, so `eng-1001` on an agent reads as `ENG-1001` everywhere after.

## Output

| Field | Type | Description |
|---|---|---|
| `target` | enum | as asked |
| `id` | string | the workspace's public id, or the agent's |
| `costCenter` | string or null | the stored label, or `null` when cleared |

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | | the caller is not an org Owner, Admin, or Billing member |
| `not_found` | `cost_center_not_found` | the label is not live on the organization's list |
| `not_found` | `agent_not_found` | no live agent in this workspace has that slug |
| `not_found` | `workspace_not_found` | the workspace is not in this organization |
