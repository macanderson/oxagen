# finding.fix.record

Record that the fix an open finding names was applied (Mission Control spec §12.8; ADR-062 §2). The four kinds the findings job detects have their fix in the agent's own code, harness or tool configuration, which Oxagen does not hold. Recording the change marks the finding `applied` with the request id of this invocation, which is the id its audit row carries, and the job cites only runs that start afterwards, so the saving is attributable on Spend.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/findings/fix`
- MCP: `record_finding_fix`
- Agent: `record_finding_fix`, which waits for a person's approval (`agent.requiresApproval: true`)
- Authentication: session; org Owner or Admin, checked in the handler
- Capability name: `record_finding_fix`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity; audited with target `cost.finding`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `findingId` | string | yes | a finding public id, `fnd_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `finding` | object | the finding with `status: "applied"`, `decidedAt` and `appliedActionId` set |

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal` | no signed-in user on the request |
| `forbidden` | `org_role_required` | the user is not an org Owner or Admin |
| `not_found` | `finding_not_found` | no finding with the id in the workspace |
| `conflict` | `finding_not_open` | the finding was already applied or dismissed |
