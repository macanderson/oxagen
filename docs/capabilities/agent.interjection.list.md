# list_interjections

**Name:** `list_interjections`
**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Billing:** `noBillingGate: true`. A console read is outside the metering surface (ADR-052 exclusion 2).
**Mutates:** no

## Intent

List the questions agents in this workspace paused their runs to ask a
person, soonest expiry first, cursor-paged (#3839). An interjection is a run
waiting on an answer, not a tool call waiting on approval, so it has its own
table, `agent.interjections`, beside `agent.approval_requests`.
`answer_interjection` is the write that answers one.

The app reads the open questions for three places: the Fleet page's Waiting on
a human tile, the Fleet count in the sidebar and on the phone's bar, and the
first rows of the shell's approvals drawer.

Nothing raises an interjection yet. No runtime writes the table, so the list is
empty in production until a producer lands.

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/agent/interjections/list`
- MCP: `list_interjections`
- Agent: offered through `search_tools` and `load_tools`. Low risk, no approval.
- Authentication: session or API key (org Owner or Admin; workspace Owner or Member)

## Input

| Field    | Type       | Notes                                                                  |
| -------- | ---------- | ---------------------------------------------------------------------- |
| `runId`  | `string?`  | Only questions raised in this run (`arun_…` or `tse_…`).               |
| `open`   | `boolean`  | Default true: only unanswered questions whose run still waits. False lists every question. |
| `limit`  | `int`      | 1 to 100, default 50.                                                  |
| `cursor` | `string?`  | The `nextCursor` of the previous page. A cursor this capability did not mint starts over. |

## Output

| Field        | Type             | Notes                              |
| ------------ | ---------------- | ---------------------------------- |
| `items[]`    | see below        | Soonest expiry first, then by id.  |
| `nextCursor` | `string \| null` | Null on the last page.             |

Each item:

| Field        | Type             | Source |
| ------------ | ---------------- | ------ |
| `id`         | `string`         | `agent.interjections.public_id` (`inj_…`), the id `answer_interjection` accepts. |
| `runId`      | `string`         | `run_public_id`: the run that asked (`arun_…` or `tse_…`). |
| `agentKey`   | `string \| null` | `agent_key` (`org_ns.ws_ns.slug`, ADR-024). Null when the writer recorded none. |
| `question`   | `string`         | The question as the agent asked it. |
| `raisedAt`   | RFC 3339         | `raised_at`. |
| `expiresAt`  | RFC 3339         | `expires_at`: when the run stops waiting and carries on without an answer. The writer sets it to `raised_at` plus the skill's interjection timeout (30 minutes, `SKILL_INTERJECTION_TIMEOUT_MS`). |
| `answeredAt` | RFC 3339 or null | `answered_at`. Null while the question is open. |
| `answer`     | `string \| null` | The answer a person gave. Null while open. |
| `answeredBy` | `string \| null` | `auth.users.public_id` (`usr_…`) of the person who answered, through `answered_by_user_id`. Null while open. |

## Semantics

- **Open:** `answered_at IS NULL AND expires_at > now()`. `get_nav_counts`
  counts on the same predicate.
- **Workspace-bound:** every query names `org_id` and `workspace_id` as well as
  relying on RLS, so a stack that runs with the RLS bypass on still lists this
  workspace's questions only.
- **Paging:** the cursor is the last row's `(expires_at, public_id)`, so a page
  after the cursor has no duplicate and no gap when several rows share an
  expiry.

## Side effects

None.

## Errors

| code            | meaning                                          |
| --------------- | ------------------------------------------------ |
| `invalid_input` | `limit` outside 1 to 100, or an unknown field.   |
