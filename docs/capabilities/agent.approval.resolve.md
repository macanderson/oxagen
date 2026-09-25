# resolve_approval

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Approve or deny a pending tool-call approval request. Approving a stored built-in call from the in-app assistant queues that exact call for a fresh authorization check and a new evidence run. The worker attempts it once. A crash can leave the outcome indeterminate, which requires inspection before requesting another action. Read the execution state and new run id through `list_resolved_approvals` (ADR-118).

Legacy approvals without stored arguments keep their existing wait or caller-retry behavior. External MCP approvals do not use the stored-call worker.

A person makes this decision. The contract is not on the `agent` surface, so no model is offered it as a tool (ADR-175). People resolve from Fleet, the Run page, and the shell's approvals drawer, which invoke through the app's kernel seam.

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

## Roles

Org Owner or Admin, or workspace Owner or Member, checked by the handler (`assertOrgRole`, INV-29). A row the mandate gate parked (ADR-059 decision 4) is answered by the office accountable for the consequence (MC spec §6.9): the caller also holds an org role the workspace's consequence roles name for every tag on the mandate (`assertConsequenceRole`), is one of the mandate's `approval.approvers` when the rule names any (`assertApprover`), and is not an agent principal. On any row, a call that carries the run the row records as raising the approval is refused. Every refusal comes before the ledger or the row is touched.

## Billing

This is the one billed action of the approvals surface (ADR-114, #2950 decision
1). The contract carries no `noBillingGate`, so the billing admission gate fires
after IAM and before the handler, and an organization out of credit gets
`gau_exhausted`, `billing_suspended`, or `budget_exceeded`. The reads beside it
(`list_approvals`, `list_resolved_approvals`, `get_auto_eligibility`) are
console reads and meter nothing, so an operator with no credit can still read
the queue and see why a call is parked.

## App

The `app` layer is the Fleet approvals panel and the same panel on the Run
page's Approvals tab. A card carries the four-hop chain, the recorded
auto-approval evaluation, and a Decide control that opens the approve or deny
dialog. The dialog writes through the kernel seam
(`apps/app/src/features/fleet/actions.ts` → `kernelWrite`), and a denial with no
reason is refused before the kernel: the note is the whole record of why a call
an agent was authorised to make was refused.

## Side effects

- Postgres: update `agent.approvals` row; insert audit row in `agent.approval_events`.
- Postgres, on a row the mandate gate parked and `denied`: the `release` rows in `tools.mandate_ledger`, written in the same transaction as the resolution under the mandate row lock (ADR-059 decision 5), so the two commit or roll back together.
- SSE: emit `approval.resolved` event so the chat stream resumes.
- ClickHouse: emit `agent.approval.resolved` row.

## Errors

| code        | reason              | meaning                                                                                                                                           |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forbidden` | `no_principal`      | No signed-in user and no API key with a live creator (403).                                                                                       |
| `forbidden` | `org_role_required` | The acting user (the signed-in user, or the API key's creator) is not an org Owner or Admin, nor a workspace Owner or Member (403). On a row a mandate parked, also: the acting user holds no org role the workspace names for every consequence tag on the mandate. |
| `forbidden` | `no_role_covers_all_tags` | On a row a mandate parked: no single org role is named for all of the mandate's consequence tags (403). |
| `forbidden` | `not_an_approver` | On a row a mandate parked whose approval rule names `approvers`: the acting user is neither a `user:` entry nor holds a `role:` entry (403). |
| `forbidden` | `agent_cannot_resolve_own_mandate` | On a row a mandate parked: the caller is an agent principal. A person answers (403). |
| `forbidden` | `run_cannot_resolve_own_approval` | The call carries the run that raised the approval (`run_public_id` on the row, matched by the run's internal or public id). A person approves or denies it on Fleet (403). |
| `conflict`  | `approval_expired`  | No pending row matched: unknown id, expired, already resolved, or another workspace (409). The call is not a governed action and is never billed. |

## SPEC references

- §3 — approval flow
- §4 — new capabilities
