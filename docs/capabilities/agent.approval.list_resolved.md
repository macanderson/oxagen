# agent.approval.list_resolved

**Name:** `list_resolved_approvals`
**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, cli
**Risk level:** low
**Billing:** `noBillingGate: true` (a console read is outside the metering surface, ADR-052 exclusion 2)
**Mutates:** no

## Intent

List the workspace's resolved approvals, most recently resolved first,
cursor-paged. This is the read `list_approvals` cannot serve: that capability
filters `resolution IS NULL`, so a row `autoApprovePath`
(`packages/rules/src/auto-approval-path.ts`) writes fully resolved the instant
a decision rule releases a call with no person never appears there (#3153).
The same query answers "what did a rule let through" and "what did a person
approve or deny", and the id it returns is what `get_auto_eligibility` needs.

## Input

| Field    | Type      | Notes                                                        |
| -------- | --------- | ------------------------------------------------------------ |
| `runId`  | `string?` | Only approvals parked in this run (`arun_…` or `tse_…`).     |
| `since`  | `string?` | RFC 3339. Only rows resolved at or after this instant.       |
| `until`  | `string?` | RFC 3339. Only rows resolved at or before this instant.      |
| `limit`  | `int`     | 1–100, default 50.                                           |
| `cursor` | `string?` | The `nextCursor` of the previous page. Unknown cursors start over. |

## Output

| Field        | Type                     | Notes                                   |
| ------------ | ------------------------ | --------------------------------------- |
| `items[]`    | see below                | Most recently resolved first, then by id (descending). |
| `nextCursor` | `string \| null`         | Null on the last page.                  |

Each item:

| Field            | Type             | Source                                                                                      |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `id`             | `string`         | `agent.approval_requests.public_id` (`apr_…`), the id `get_auto_eligibility` accepts.       |
| `runId`          | `string \| null` | The run the call was parked in. Null when none was in scope.                                |
| `tool`           | `string`         | `approval_requests.capability_name`.                                                        |
| `requester`      | `string \| null` | `auth.users.public_id` (`usr_…`) of the person whose conversation turn parked the call. Null when that chain is not readable. |
| `createdAt`      | RFC 3339         | `approval_requests.created_at`.                                                             |
| `expiresAt`      | RFC 3339         | `approval_requests.expires_at`.                                                             |
| `resolvedAt`     | RFC 3339         | `approval_requests.resolved_at`.                                                            |
| `resolution`     | `"approved" \| "denied" \| "expired"` | `approval_requests.resolution`.                                        |
| `resolvedBy`     | `string \| null` | `user:<usr_…>` or `policy:<rule id>`, mutually exclusive on the row (ADR-070).               |
| `autoRuleId`     | `string \| null` | `approval_requests.auto_rule_id`, echoed on its own so a caller need not decode `resolvedBy` to show it. |
| `chain.agentKey` | `string \| null` | The agent that raised the call. Not recorded today.                                         |
| `mandateId`      | `string \| null` | `tools.mandates.public_id` (`mnd_…`) of the mandate the parked call drew on. Null on a chat gate row. |
| `chain.rule`     | `string \| null` | The first of `rule_ids`. Null on a chat gate row.                                            |
| `autoEligibility`| object or `null` | The evaluation recorded when the call was parked (ADR-070). Null when no rule covered it.    |

Only public ids leave the handler.

## Semantics

- **Resolved only:** `resolution IS NOT NULL AND resolved_at IS NOT NULL`. A
  still-pending row never appears here. That is `list_approvals`.
- **Workspace-bound:** rows are filtered on the context's org and workspace
  (RLS enforces the tenant boundary independently of the query).
- **`runId` / `since` / `until`:** each narrows the same predicate; omitted,
  the full resolved history for the workspace is paged.
- **Paging:** the cursor is the last row's `(resolved_at, public_id)`,
  descending, so a page after the cursor has no duplicate and no gap even when
  several rows share a `resolved_at`.
- **The Run page's reading:** the Approvals tab walks this cursor for one run,
  up to 10 pages of 100 rows. When the tenth page still carries a
  `nextCursor`, the app keeps that as `more`, and the panel says it shows the
  1,000 most recent resolved approvals and that the run has more. The first
  1,000 never read as the whole ledger (#3477,
  `apps/app/src/data/live/approvals.ts`).

## Side effects

None.

## Errors

| code            | meaning                                    |
| --------------- | ------------------------------------------ |
| `invalid_input` | `limit` outside 1–100, `since`/`until` not RFC 3339, or an unknown field. |

## Resumed calls

A stored built-in call includes `execution`: its `status`, the new `runId` when recorded, and a named refusal `reason` when present. `dispatched` means an async capability accepted dispatch. `indeterminate` means the external outcome is unknown and the worker will not retry. Legacy rows omit this object.
