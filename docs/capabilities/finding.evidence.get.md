# finding.evidence.get

The evidence behind one finding: the arithmetic the findings job wrote with it (Mission Control spec §12.8; ADR-062). Nothing is re-estimated on read.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/findings/evidence`
- MCP: `get_finding_evidence`
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `get_finding_evidence`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `findingId` | string | yes | a finding public id, `fnd_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `finding` | object | the finding, as `list_findings` answers it |
| `evidence.calls` | integer | the calls the finding cites |
| `evidence.coveredCalls` | integer | the cited calls the counterfactual prices; the rest add nothing to the saving |
| `evidence.measuredTokens`, `evidence.counterfactualTokens` | integer | the tokens the covered calls carried, and the tokens the alternative would have |
| `evidence.measured`, `evidence.counterfactual` | money | what the covered calls cost at the price each run paid, and what the alternative would have; the saving is the difference |
| `evidence.runs` | object[] | the cited runs with the largest saving, at most ten: `{ runId, startedAt, calls, measuredTokens, counterfactualTokens, measured, counterfactual }` |

## Errors

| Code | Reason | When |
|---|---|---|
| `not_found` | `finding_not_found` | no finding with the id in the workspace |
