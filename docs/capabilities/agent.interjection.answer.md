# answer_interjection

**Name:** `answer_interjection`
**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, cli
**Risk level:** low
**Billing:** `noBillingGate: true`. ADR-055's 2026-09-15 ratification makes `resolve_approval` the only billable action.
**Mutates:** yes

## Intent

Answer the question an agent paused its run to ask (#3839). The answer is
recorded on the question in `agent.interjections`. For a wrapped run whose host
can take it, the answer also reaches the run as a `message` command.

A person makes this decision, so the contract is not on the `agent` surface
(ADR-175), the same as `resolve_approval`. The app has no place to answer yet:
the approvals drawer lists the question and links to its run.
`list_interjections` is the read.

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/agent/interjections/answer`
- MCP: `answer_interjection`
- CLI: `oxagen run answer <interjection-id> (--text <answer> | --link | --create <name> --slug <slug>)`
- Authentication: session or API key

## Input

| Field            | Type     | Notes |
| ---------------- | -------- | ----- |
| `interjectionId` | `string` | The public id (`inj_…`) or the row uuid. Anything else is refused at the edge. |
| `answer`         | `string` | 1 to 4,000 characters after trimming. |

## Output

| Field            | Type       | Notes |
| ---------------- | ---------- | ----- |
| `interjectionId` | `string`   | The question's public id (`inj_…`), whichever id form was sent. |
| `runId`          | `string`   | The run that asked (`arun_…` or `tse_…`). |
| `answeredAt`     | RFC 3339   | When the answer was recorded. |
| `commandIds`     | `string[]` | The `tcm_…` id of the queued `message` command. Empty for a ledger run, and when the run's host cannot take a command. |

## Roles

Org Owner or Admin, or workspace Owner or Member, checked by the handler
(`assertOrgRole`) for the signed-in user or the creator of the API key. The
kernel's IAM check allows every capability for a non-enterprise organization,
so the handler's check is the enforcement.

## Semantics

1. The handler locks the question by either id form inside the caller's org
   and workspace, whatever its state.
2. A question someone answered refuses a second answer. A question past its
   expiry refuses too, because its run has carried on. Both refusals come
   before any write.
3. One update records `answered_at`, `answer`, and `answered_by_user_id`,
   guarded by `answered_at IS NULL AND expires_at > now()`. The row lock makes
   a second answer wait for the first and then find it answered.
4. For a `tse_…` run, the handler queues a `message` command in the same
   transaction, under the rule `dispatch_command` and every Fleet row read
   (`commandBlockOf`, `steerBlockOf`). A sealed run, a host that is revoked or
   silent for five minutes, and a harness that reads text only at session start
   get no command. The command asks for `next_step` delivery and records the
   mode the host can carry. It expires with the question.
5. An `arun_…` ledger run has no connection point, so its answer stays on the
   question.

## Side effects

- Postgres: update the `agent.interjections` row.
- Postgres, for a wrapped run whose host can take it: insert one
  `tacho.control_commands` row (`command = message`, `payload.text` the answer,
  `payload.interjection_id` the question). The host seals it on the run's chain
  as an `oxagen:command_applied` frame.
- Audit: the kernel writes `capability.invoke_allowed` for the call. No
  domain-specific security event is written.

## Errors

| code        | reason                  | meaning |
| ----------- | ----------------------- | ------- |
| `forbidden` | `no_principal`          | No signed-in user and no API key with a live creator (403). |
| `forbidden` | `org_role_required`     | The acting user is not an org Owner or Admin, nor a workspace Owner or Member (403). |
| `conflict`  | `interjection_answered` | Someone already answered the question (409). |
| `conflict`  | `interjection_expired`  | The question's run stopped waiting, or the id names no question in this workspace (409). The answer does not say which, so it never tells a caller whether an id exists elsewhere. |
| `invalid_input` | | An empty or over-long answer, or an id of the wrong form. |
