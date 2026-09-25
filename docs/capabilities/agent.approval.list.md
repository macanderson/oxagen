# list_approvals

**Name:** `list_approvals`
**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Billing:** `noBillingGate: true` — a console read is outside the metering surface (ADR-052 exclusion 2)
**Mutates:** no

## Intent

List the workspace's pending tool-call approvals, soonest expiry first,
cursor-paged. This is the read behind the Fleet approvals panel and the Run
approvals strip (`apps/app/ARCHITECTURE.md` §1.2). `resolve_approval` is the
write that answers an item.

The in-app assistant pins this read (`INTERACTIVE_AGENT_CAPABILITIES`), so
every turn can say which tool calls wait on a person. It needs no approval.

## Input

| Field    | Type      | Notes                                                        |
| -------- | --------- | ------------------------------------------------------------ |
| `runId`  | `string?` | Only approvals parked in this run (`arun_…` or `tse_…`).     |
| `limit`  | `int`     | 1–100, default 50.                                           |
| `cursor` | `string?` | The `nextCursor` of the previous page. Unknown cursors start over. |

## Output

| Field        | Type                     | Notes                                   |
| ------------ | ------------------------ | --------------------------------------- |
| `items[]`    | see below                | Soonest expiry first, then by id.       |
| `nextCursor` | `string \| null`         | Null on the last page.                  |

Each item:

| Field            | Type             | Source                                                                                      |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `id`             | `string`         | `agent.approval_requests.public_id` (`apr_…`), the id `resolve_approval` accepts.          |
| `runId`          | `string \| null` | The run the call was parked in (`approval_requests.run_public_id`, #3286). Null when no run was in scope, or when the writer records none yet. |
| `tool`           | `string`         | `approval_requests.capability_name`.                                                        |
| `requester`      | `string \| null` | `auth.users.public_id` (`usr_…`) of the person whose conversation turn parked the call, through `message_id` → `chat.messages` → `chat.conversations.user_id`. Null when that chain is not readable. |
| `createdAt`      | RFC 3339         | `approval_requests.created_at`.                                                             |
| `expiresAt`      | RFC 3339         | `approval_requests.expires_at`.                                                             |
| `chain.agentKey` | `string \| null` | The agent that raised the call. Not recorded today.                                         |
| `mandateId`      | `string \| null` | `tools.mandates.public_id` (`mnd_…`) of the mandate the parked call drew on (ADR-059). Null on a chat gate row. |
| `chain.rule`     | `string \| null` | The rule that parked the call: the first of `rule_ids` (`mandate:<id>:human_above:<measure>` or `…:always_human_for:<tag>`). Null on a chat gate row. |

Only public ids leave the handler.

## Semantics

- **Pending only:** `resolution IS NULL AND expires_at > now()`. A resolved or
  expired approval is not listed.
- **Workspace-bound:** rows are filtered on the context's org and workspace.
- **`runId`:** filters on `approval_requests.run_public_id`, which the chat
  gate records by resolving the run it holds (`ctx.agentRun.runId`, an internal
  id) to its public one at write time. It is a public id because both kinds of
  run this product tracks have to be representable and no one table holds both.
  The mandate gate and the MCP consent path do not thread a run through yet, so
  a call parked by either records null — a run whose calls were all parked that
  way answers an empty page, which is the truth about the record and not a
  filter that was ignored.
- **Paging:** the cursor is the last row's `(expires_at, public_id)`, so a
  page after the cursor has no duplicate and no gap even when several rows
  share an expiry.

## Side effects

None.

## Errors

| code            | meaning                                    |
| --------------- | ------------------------------------------ |
| `invalid_input` | `limit` outside 1–100, or an unknown field. |
