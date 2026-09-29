# get_conversation

**Domain:** conversation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Read one of your conversations in a workspace with its messages, oldest
first. With no id, read your most recently updated active conversation, the
thread the app's assistant flyout reopens after a reload (#4163).

The ownership rule is the one `list_conversations`, `rename_conversation`,
`archive_conversation` and `delete_conversation` apply: the conversation is in
this workspace, belongs to you, and is not deleted. An archived conversation of
your own can be read by its id. Anything else answers `not_found`, the same
answer as an id that does not exist, so the read confirms nothing about a
conversation that is not yours. An API key reads as the person who created it,
the same person `ask_assistant` records the key's turns under.

Messages follow the conversation's active branch. A conversation whose
messages name no parent, which is how `ask_assistant` writes its turns, reads
in the order it was written. Rows with a role other than `user`, `assistant`
or `system` are left out, as the assistant's own transcript leaves them out.

## Input

| Field            | Type                 | Notes                                                                   |
| ---------------- | -------------------- | ----------------------------------------------------------------------- |
| `conversationId` | `string \| null`     | The `cnv_` public id. Null reads your latest active conversation. Defaults to null. |
| `limit`          | `number` (1 to 200)  | The newest messages to return. Defaults to 100.                         |

## Output

| Field          | Type             | Notes                                                                 |
| -------------- | ---------------- | --------------------------------------------------------------------- |
| `conversation` | object or `null` | Null only when no id was given and you have no active conversation.   |

`conversation` carries the `list_conversations` summary fields (`publicId`,
`title`, `status`, `archivedAt`, `createdAt`, `updatedAt`) and:

| Field       | Type                                                                                          | Notes                                                        |
| ----------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `messages`  | `Array<{ publicId, role, content, createdAt, runId, parkedCards, toolCalls, stopped, attachments }>` | Oldest first. `runId` is the `arun_` run an assistant turn was recorded as, or null. `parkedCards` are the governed writes that turn parked for a person, each `{ approvalId, capability, expiresAt }`. `toolCalls` are the tool calls behind a reply, in the shape `ask_assistant` returns them. `stopped` is true when the person stopped the turn, so `content` is the part of the reply written before the stop. `attachments` are the files the person sent with a question. |
| `truncated` | `boolean`                                                                                     | True when `limit` left earlier messages out.                 |

### Tool calls

Each reply's `toolCalls` is read from its run in the run ledger, the record of
what the turn called. It is never copied onto the message, so a restored reply
lists what the live reply listed (#4161). Each entry is
`{ toolCallId, toolName, outcome, durationMs, approvalId }`, in the order the
run recorded the calls. `outcome` is `completed`, `failed`, `denied`,
`cancelled` or `parked`. `approvalId` is the public id of the approval a
parked call waits on, the same id as that reply's parked card, and is null on
every other call.

One ledger read answers every reply returned, however many there are. Only
the runs of the replies inside `limit` are read.

`toolCalls` is empty on a `user` or `system` message and on a reply with no
run. If the ledger cannot be read, the conversation is still returned: every
reply lists no calls, and the handler logs the failure as a warning.
### Attachments

Each message's `attachments` lists the files the person sent with it, in the
order they were uploaded (#4690). Each entry is
`{ publicId, name, mediaType, sizeBytes, sha256 }`, the shape
`upload_assistant_attachment` returned when the file was attached. Open a
file through `GET /v1/:org/:workspace/assistant/attachments/:publicId`.

One query reads the files of every message returned, however many there are.
Only files you uploaded to this conversation are read. A file that was
deleted, or never finished storing, is left out, and so is a file that no
message sent. `delete_conversation` soft-deletes a conversation's files with
it.

`attachments` is empty on a message sent without files and on every
`assistant` or `system` message.

## Surfaces

- **API:** `GET /v1/:org/:workspace/conversations/latest` and
  `GET /v1/:org/:workspace/conversations/:conversationId`, each with an
  optional `?limit=`
- **MCP:** `get_conversation` tool (read-only, idempotent)
- **App:** the assistant flyout reads your latest conversation when it opens
  (`apps/app/src/features/shell/assistant-thread-actions.ts`), and draws each
  sent file as the chip it showed when the question was sent

Not on the agent surface: a turn already carries its own conversation as the
model's transcript, and no assistant task needs to read another one.

## Side effects

None. Read-only against PostgreSQL: the conversation store, the run ledger
for the replies' tool calls, and `generated_assets` for the files sent. The
billing gate is skipped (`noBillingGate`), because reading your own history
uses no model.

## Errors

| code                                       | meaning                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `not_found` (reason `conversation_not_found`) | The id names no conversation of yours in this workspace, or it is deleted. |
| `forbidden` (reason `no_principal`)        | The caller carries no person to read as: an API key with no recorded creator. |
| `invalid_input`                            | `conversationId` is not a `cnv_` public id, or `limit` is out of range.   |
