# finding.dismiss

Dismiss an open finding without applying its fix (Mission Control spec §12.8; ADR-062). The finding keeps its evidence and the decision; the findings job opens it again only on runs that start after the dismissal.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/findings/dismiss`
- MCP: `dismiss_finding`
- Authentication: session; org Owner or Admin, checked in the handler
- Capability name: `dismiss_finding`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity; audited with target `cost.finding`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `findingId` | string | yes | a finding public id, `fnd_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `finding` | object | the finding with `status: "dismissed"` and `decidedAt` set; `appliedActionId` stays null |

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal` | no signed-in user on the request |
| `forbidden` | `org_role_required` | the user is not an org Owner or Admin |
| `not_found` | `finding_not_found` | no finding with the id in the workspace |
| `conflict` | `finding_not_open` | the finding was already applied or dismissed |
