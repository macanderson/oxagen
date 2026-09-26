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

Answer the question a run paused to ask. There are two kinds, and
`list_interjections` names the kind of each.

- A `question` is an agent asking in its own words (#3839). It takes a
  free-text `answer`.
- A `repo_unknown` is a Tacho host holding a session that started in a
  repository no workspace in the organization has bound, while the workspace
  has skills on (#3941). It takes a `path`. `link` binds the repository to
  this workspace. `create` makes a new workspace for it, with the repository
  as its main one and skills off.

Every answer is recorded on the question in `agent.interjections` with a new
`rcp_…` receipt, and one `agent.interjection_answered` security event carries
the same receipt. For a wrapped run whose host can take it, the answer also
reaches the run as a `message` command. For a `repo_unknown`, that command
releases the host's hold, and the host seals `control.answer` and the frames
that record what the answer did.

A person makes this decision, so the contract is not on the `agent` surface
(ADR-175), the same as `resolve_approval`. `list_interjections` is the read.
A `repo_unknown` nobody answers resolves to `deny` at its deadline, and the
run goes on with no skills. The timeout writes that answer, never a person.

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/agent/interjections/answer`
- MCP: `answer_interjection`
- CLI: `oxagen run answer <interjection-id> (--text <answer> | --link | --create <name> --slug <slug>)`
- App: the Run page at `/{org}/{ws}/runs/{run}`, for a run whose host held the loop on a repository question. The page shows both paths, sends `link` or `create` through the kernel seam, and shows the receipt (`apps/app/src/features/run/interjection-answer.tsx`). A `question` has no answer form in the app yet.
- Authentication: session or API key

## Input

| Field            | Type     | Notes |
| ---------------- | -------- | ----- |
| `interjectionId` | `string` | The public id (`inj_…`) or the row uuid. Anything else is refused at the edge. |
| `answer`         | `string?` | 1 to 4,000 characters after trimming. Required on a `question`, refused on a `repo_unknown`. |
| `path`           | `link \| create`? | Required on a `repo_unknown`, refused on a `question`. `deny` is not accepted: only the timeout answers it. |
| `create`         | `{ name, slug }?` | The new workspace's name (1 to 120 characters) and slug (the `create_workspace` slug rules). Required when `path` is `create`, refused otherwise. |

## Output

| Field            | Type       | Notes |
| ---------------- | ---------- | ----- |
| `interjectionId` | `string`   | The question's public id (`inj_…`), whichever id form was sent. |
| `runId`          | `string`   | The run that asked (`arun_…` or `tse_…`). |
| `answeredAt`     | RFC 3339   | When the answer was recorded. |
| `commandIds`     | `string[]` | The `tcm_…` id of the queued `message` command. Empty for a ledger run, and when the run's host cannot take a command. |
| `receiptId`      | `string`   | The receipt (`rcp_…`). The row, the security event and the host's `control.answer` frame carry the same one. |
| `path`           | `link \| create \| null` | The path taken. Null for a free-text answer. |
| `repository`     | `{ bindingId, fullName } \| null` | The binding a link or create wrote, and `owner/name`. Null for a free-text answer. |
| `workspace`      | `{ publicId, slug } \| null` | The workspace a create made. Null on every other answer. |

## Roles

Checked by the handler (`assertOrgRole`) for the signed-in user or the creator
of the API key. The kernel's IAM check allows every capability for a
non-enterprise organization, so the handler's check is the enforcement.

- A free-text answer: org Owner or Admin, or workspace Owner or Member.
- A `link` or `create`: org Owner or Admin, or workspace Owner. These are the
  roles of `link_repository` and `create_workspace`, which the path runs. A
  workspace Member can answer a free-text question and cannot take either
  path.

## Semantics

1. The handler reads the question by either id form inside the caller's org
   and workspace, whatever its state. No row, or a question past its expiry,
   is `interjection_expired`. A field the question's kind does not take, or a
   missing one it needs, is `interjection_answer_shape`. A question someone
   answered is `interjection_answered`. All three come before any write.
2. For a `repo_unknown`, the handler takes the repository from the row. When
   the row names none yet, it matches the frame's remote digest against the
   repositories the workspace's GitHub installation reaches, the way the host
   digests its remote. The host never sends the remote itself. No match is
   `interjection_repository_unresolved`.
3. The path runs through the kernel as its own capability, outside any
   transaction, because both call GitHub. `link` runs `link_repository` on the
   repository. `create` runs `create_workspace` with it as the main
   repository. An enterprise organization's policies and each capability's
   own audit row apply to them, and their refusals (`main_repo_claimed`,
   `slug_taken`, `github_not_connected` and the rest) reach the caller as
   they are. A link retried after it bound the repository takes the existing
   binding as its own.
4. One transaction then locks the question and checks it again. One update
   records `answered_at`, `answer`, `answered_by_user_id`, `path` and
   `receipt_id`, guarded by `answered_at IS NULL AND expires_at > now()`. The
   row lock makes a second answer wait for the first and then find it
   answered. A link or create that succeeded before this step found the
   question answered stays done.
5. For a `tse_…` run, the handler queues a `message` command in the same
   transaction. A free-text answer follows the rule `dispatch_command` and
   every Fleet row read (`commandBlockOf`, `steerBlockOf`): a sealed run, a
   host that is revoked or silent for five minutes, and a harness that reads
   text only at session start get no command. A path answer follows
   `commandBlockOf` alone, because the host applies the release, not the
   harness. The command asks for `next_step` delivery and records the mode
   the host can carry. A free-text answer's command expires with the
   question. A path answer's command waits an hour for the host, because the
   host holds the loop until its next prompt past its own deadline, and an
   answer given in the last seconds must still reach it.
6. An `arun_…` ledger run has no connection point, so its answer stays on the
   question.

## Side effects

- Postgres: update the `agent.interjections` row, with the resolved
  `repository` when the row had none.
- Postgres, for a wrapped run whose host can take it: insert one
  `tacho.control_commands` row (`command = message`, `payload.text` the
  answer or what the path did, `payload.interjection_id` the question). A
  path answer adds `payload.interjection`: the host's interjection key, the
  path, `source: person`, the receipt, the person's `usr_…` id, the binding,
  and the workspace. The host seals `control.answer`, then `repo.bound` after
  a link, or `workspace.created`, `repo.bound` and `skills.resolved` after a
  create, and releases the hold. A free-text answer is sealed as an
  `oxagen:command_applied` frame.
- Audit: one `agent.interjection_answered` security event in the same
  transaction, with the question, its run and kind, the path, `source:
  person`, the receipt, the binding and workspace a path wrote, and the
  command ids. Never the answer text. The kernel also writes
  `capability.invoke_allowed` for the call, and for the nested
  `link_repository` or `create_workspace`.

## Timeout

The ingest sends `agent/interjection.raised` for each `repo_unknown` row it
writes. The durable function `agent/interjection-timeout` then:

1. matches the repository from the frame's remote digest and writes it onto
   the row, so the Run page can name it before anyone answers,
2. sleeps until `expires_at`, 30 minutes after the frame
   (`SKILL_INTERJECTION_TIMEOUT_MS`), and
3. when nobody answered, records `path = deny` with no person, a receipt,
   and the event with `source: timeout`, and queues the `message` that
   releases the host's hold and tells the agent it goes on without skills.
   When the host's own timeout answered first, it adds the receipt and the
   event only. A person's answer is left alone.

## Errors

| code        | reason                  | meaning |
| ----------- | ----------------------- | ------- |
| `forbidden` | `no_principal`          | No signed-in user and no API key with a live creator (403). |
| `forbidden` | `org_role_required`     | The acting user lacks the roles the answer's form needs (403). |
| `conflict`  | `interjection_answered` | Someone already answered the question (409). |
| `conflict`  | `interjection_expired`  | The question's run stopped waiting, or the id names no question in this workspace (409). The answer does not say which, so it never tells a caller whether an id exists elsewhere. |
| `conflict`  | `interjection_answer_shape` | The fields do not fit the question's kind: free text on a `repo_unknown`, a path on a `question`, `create` without its workspace, or `link` with one (409). |
| `conflict`  | `interjection_repository_unresolved` | No repository the workspace's GitHub installation reaches matches the host's remote (409). |
| `invalid_input` | | An empty or over-long answer, a path other than `link` or `create`, an unknown field, or an id of the wrong form. |

A `link` or `create` refusal from the nested capability passes through with
its own code and reason.
