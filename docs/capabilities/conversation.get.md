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

| Field       | Type                                                                  | Notes                                                        |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `messages`  | `Array<{ publicId, role, content, createdAt, runId, parkedCards }>`   | Oldest first. `runId` is the `arun_` run an assistant turn was recorded as, or null. `parkedCards` are the governed writes that turn parked for a person, each `{ approvalId, capability, expiresAt }`. |
| `truncated` | `boolean`                                                             | True when `limit` left earlier messages out.                 |

## Surfaces

- **API:** `GET /v1/:org/:workspace/conversations/latest` and
  `GET /v1/:org/:workspace/conversations/:conversationId`, each with an
  optional `?limit=`
- **MCP:** `get_conversation` tool (read-only, idempotent)
- **App:** the assistant flyout reads your latest conversation when it opens
  (`apps/app/src/features/shell/assistant-thread-actions.ts`)

Not on the agent surface: a turn already carries its own conversation as the
model's transcript, and no assistant task needs to read another one.

## Side effects

None. Read-only against PostgreSQL. The billing gate is skipped
(`noBillingGate`), because reading your own history uses no model.

## Errors

| code                                       | meaning                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `not_found` (reason `conversation_not_found`) | The id names no conversation of yours in this workspace, or it is deleted. |
| `forbidden` (reason `no_principal`)        | The caller carries no person to read as: an API key with no recorded creator. |
| `invalid_input`                            | `conversationId` is not a `cnv_` public id, or `limit` is out of range.   |
