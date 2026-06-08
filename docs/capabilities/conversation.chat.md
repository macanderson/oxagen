# conversation.chat

**Domain:** conversation
**Mode:** sync
**Scope:** tenant (org + workspace)

## Intent

Post a message to an existing conversation. Appends the message to the conversation thread in `chat.messages`. The caller's user ID is set as the author.

## Input

| Field             | Type              | Notes                                                |
| ----------------- | ----------------- | ---------------------------------------------------- |
| `conversation_id` | `string`          | ID of the target conversation.                       |
| `message`         | `string` (opt.)   | Message content. Defaults to empty string if absent. |

## Output

| Field        | Type                | Notes                            |
| ------------ | ------------------- | -------------------------------- |
| `message_id` | `string`            | ID of the created message.       |
| `created_at` | `string` (ISO 8601) | Server-side creation timestamp.  |
| `author`     | `string`            | User ID of the message author.   |

## Side effects

- Postgres: inserts `chat.messages` row.

## Errors

| code        | meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| `not_found` | No conversation with the given ID in the caller's workspace. |
| `forbidden` | Caller lacks access to the conversation.                     |

## SPEC references

- docs/architecture/chat/spec.md — §conversation.chat
