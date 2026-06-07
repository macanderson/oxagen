# conversation.rename

**Domain:** conversation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Set a conversation's title. Reversible, low-risk metadata edit — exposed as a long-press / double-click action in the conversation history nav so users can name otherwise-untitled "New conversation" rows. No confirmation required.

## Input

| Field | Type | Notes |
|---|---|---|
| `conversationId` | `string` (1+ chars) | The `cnv_` public ID of the conversation to rename. |
| `title` | `string` (1–200 chars, trimmed) | The new title. Whitespace is trimmed before storage. |

## Output

| Field | Type | Notes |
|---|---|---|
| `publicId` | `string` | Echo of the conversation's public ID. |
| `title` | `string` | The stored title after update. |

## Roles

Org Owner, Org Admin. Workspace Owner, Member.

## Side effects

- Postgres: `UPDATE conversations SET title = $title WHERE public_id = $id AND workspace_id = $workspace`.

## Surfaces

- `POST /v1/:org/:workspace/conversations/rename`
- MCP tool `conversation_rename`
- Agent: no approval required, risk `low`, category `conversation`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller lacks workspace Member role or higher, or does not own the conversation. |
| `not_found` | No conversation with the given public ID exists in this workspace. |
| `validation_error` | Input failed Zod parse (e.g., empty title after trim). |
