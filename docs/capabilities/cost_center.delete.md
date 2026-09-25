# delete_cost_center

Delete a label from the organization's cost-center list (ADR-142). The delete is soft: the row stays, so statements already built still name the label. Every agent and workspace that names the label is cleared, deleted agents and archived workspaces included, so their new runs fall back to the workspace's cost center, or to none. Runs already rolled up keep the cost center they had.

Agents are cleared in each workspace's own scope before the label and the workspaces are cleared in one last transaction. If the call fails part way, the label stays on the list and calling it again finishes the job.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/:workspace_slug/spend/cost-centers/delete`
- MCP: `delete_cost_center`
- Authentication: session (org Owner, Admin, or Billing). The handler asserts the org role itself (INV-29).
- Capability name: `delete_cost_center`
- Organization-level (`scoped: false`). The workspace in the path only routes the call.
- Not billed (`noBillingGate: true`). IAM default-deny, medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `label` | string | yes | a label in the pattern `create_cost_center` accepts |

## Output

| Field | Type | Description |
|---|---|---|
| `label` | string | the list's spelling of the deleted label |
| `deletedAt` | string | ISO 8601 |

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | | the caller is not an org Owner, Admin, or Billing member |
| `not_found` | `cost_center_not_found` | no live label matches, including a label already deleted |

Call `create_cost_center` with the same label to restore it. A restored label starts with no agents or workspaces.
