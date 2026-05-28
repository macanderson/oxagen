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
| `approvalId` | `string`                   | Approval id from the SSE approval card.     |
| `decision`   | `"approved" \| "denied"`   | Required.                                   |
| `note`       | `string?`                  | Optional human note for the audit row.      |

## Output

| Field        | Type                                       | Notes                              |
| ------------ | ------------------------------------------ | ---------------------------------- |
| `approvalId` | `string`                                   | Echoes the input id.               |
| `resolution` | `"approved" \| "denied" \| "expired"`      | Resolved state, with `expired` for stale approvals. |

## Side effects

- Postgres: update `agent.approvals` row; insert audit row in `agent.approval_events`.
- SSE: emit `approval.resolved` event so the chat stream resumes.
- ClickHouse: emit `agent.approval.resolved` row.

## Errors

| code                | meaning                                          |
| ------------------- | ------------------------------------------------ |
| `unknown_approval`  | The `approvalId` does not exist in this workspace. |
| `already_resolved`  | The approval is no longer pending.               |

## SPEC references

- §3 — approval flow
- §4 — new capabilities
