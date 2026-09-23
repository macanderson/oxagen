# create_cost_center

Add a label to the organization's cost-center list, so agents and workspaces can be charged back to it (ADR-142). The organization keeps one row per label for its whole history. Adding a label the organization deleted restores that row. Adding a label that is already live answers `conflict`.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/:workspace_slug/spend/cost-centers/create`
- MCP: `create_cost_center`
- Authentication: session (org Owner, Admin, or Billing). The handler asserts the org role itself, because the kernel's IAM check allows every member of a non-enterprise organization (INV-29).
- Capability name: `create_cost_center`
- Organization-level (`scoped: false`). The workspace in the path only routes the call.
- Not billed (`noBillingGate: true`). IAM default-deny, medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `label` | string | yes | 1 to 64 characters: a letter or digit, then letters, digits, `.`, `_`, or `-` |
| `description` | string | no | 1 to 280 characters after trimming |

The label pattern refuses `~`, so no label can collide with `~none`, the key for spend no cost center claims.

## Output

| Field | Type | Description |
|---|---|---|
| `costCenter` | cost center | the stored label, in the shape `list_cost_centers` answers, with `agents` and `workspaces` at 0 |

A restored label keeps its original `id` and `createdAt`. It keeps its old description unless the call supplies a new one.

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | | the caller is not an org Owner, Admin, or Billing member |
| `conflict` | `cost_center_exists` | the label is already live on the list |
