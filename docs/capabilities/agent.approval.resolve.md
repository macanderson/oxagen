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

| Field        | Type                       | Notes                                       |
| ------------ | -------------------------- | ------------------------------------------- |
| `approvalId` | `string`                   | The public id (`apr_…`) or the row uuid (#2906); anything else is refused at the edge. |
| `decision`   | `"approved" \| "denied"`   | Required.                                   |
| `note`       | `string?`                  | Optional human note for the audit row.      |

## Output

| Field        | Type                                       | Notes                              |
| ------------ | ------------------------------------------ | ---------------------------------- |
| `approvalId` | `string`                                   | Echoes the input id, in the form it was sent. |
| `resolution` | `"approved" \| "denied"`                    | The decision that was written.     |

## Side effects

- Postgres: update `agent.approvals` row; insert audit row in `agent.approval_events`.
- SSE: emit `approval.resolved` event so the chat stream resumes.
- ClickHouse: emit `agent.approval.resolved` row.

## Errors

| code        | reason              | meaning                                                                                       |
| ----------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `forbidden` | `org_role_required` | The caller is not an org Owner or Admin, nor a workspace Owner or Member (403).               |
| `conflict`  | `approval_expired`  | No pending row matched: unknown id, expired, already resolved, or another workspace (409). The call is not a governed action and is never billed. |

## SPEC references

- §3 — approval flow
- §4 — new capabilities
