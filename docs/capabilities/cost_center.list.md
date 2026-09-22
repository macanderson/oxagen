# list_cost_centers

The organization's cost-center labels, the labels finance charges spend back to (ADR-142). The list is one per organization, and every workspace charges back against it. Each label carries how many live agents and unarchived workspaces in the organization name it. Deleted labels are left out.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/:workspace_slug/spend/cost-centers` with body `{}`
- MCP: `list_cost_centers`
- Authentication: session (org Owner, Admin, Billing, or Member)
- Capability name: `list_cost_centers`
- Organization-level (`scoped: false`). The workspace in the path only routes the call.
- Not billed (`noBillingGate: true`). IAM default-deny, low sensitivity.

## Input

An empty object. The input is strict, so an unknown field is refused.

## Output

| Field | Type | Description |
|---|---|---|
| `costCenters` | cost center[] | the live labels, ordered by label without regard to case |

A cost center:

| Field | Type | Description |
|---|---|---|
| `id` | string | `ccn_…` |
| `label` | string | the list's spelling of the label |
| `description` | string or null | what the label charges back to |
| `agents` | integer | live agents in the organization that name the label |
| `workspaces` | integer | unarchived workspaces in the organization that name the label |
| `createdAt` | string | ISO 8601 |

The counts compare labels without regard to case, so an agent that stores `eng-1001` counts toward `ENG-1001`.
