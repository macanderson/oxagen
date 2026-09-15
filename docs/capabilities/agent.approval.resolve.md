# agent.approval.resolve

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent
**Risk level:** low

## Intent

Approve or deny a pending tool-call approval request. Resolution
resumes the paused agent stream so the runner either executes the
approved tool call or skips it and apologises.

## Input

| Field        | Type                     | Notes                                                                                  |
| ------------ | ------------------------ | -------------------------------------------------------------------------------------- |
| `approvalId` | `string`                 | The public id (`apr_…`) or the row uuid (#2906); anything else is refused at the edge. |
| `decision`   | `"approved" \| "denied"` | Required.                                                                              |
| `note`       | `string?`                | Optional human note for the audit row.                                                 |

## Output

| Field        | Type                                                                                                   | Notes                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approvalId` | `string`                                                                                               | Echoes the input id, in the form it was sent.                                                                                                                                                                                           |
| `resolution` | `"approved" \| "denied"`                                                                               | The decision that was written.                                                                                                                                                                                                          |
| `mandate`    | `{ mandateId, reserved: { measure, value, unitOrCurrency }[], outcome: "held" \| "released" } \| null` | The mandate settlement (ADR-059): on a row the mandate gate parked, the reservation the call holds and whether it stays `held` (approved: the agent's retry settles it on receipt) or was `released` (denied). Null on a chat gate row. |

## Side effects

- Postgres: update `agent.approvals` row; insert audit row in `agent.approval_events`.
- Postgres, on a row the mandate gate parked and `denied`: the `release` rows in `tools.mandate_ledger`, written in the same transaction as the resolution under the mandate row lock (ADR-059 decision 5), so the two commit or roll back together.
- SSE: emit `approval.resolved` event so the chat stream resumes.
- ClickHouse: emit `agent.approval.resolved` row.

## Errors

| code        | reason              | meaning                                                                                                                                           |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forbidden` | `org_role_required` | The caller is not an org Owner or Admin, nor a workspace Owner or Member (403).                                                                   |
| `conflict`  | `approval_expired`  | No pending row matched: unknown id, expired, already resolved, or another workspace (409). The call is not a governed action and is never billed. |

## SPEC references

- §3 — approval flow
- §4 — new capabilities
