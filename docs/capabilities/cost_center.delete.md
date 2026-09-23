# delete_cost_center

Delete a label from the organization's cost-center list (ADR-142). The delete is soft: the row stays, so statements already built still name the label. Agents and workspaces that name the label keep the value. The rollup stops charging new runs to a deleted label, and runs it already rolled up keep the cost center they had.

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

Call `create_cost_center` with the same label to restore it.
