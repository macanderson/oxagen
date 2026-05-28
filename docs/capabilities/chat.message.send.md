# chat.message.send

**Domain:** chat
**Mode:** async (streaming)
**Scope:** tenant + workspace

## Intent

Append a user message to a conversation and stream the assistant's
reply via the Vercel AI SDK. Honours Claude-style branching: when a
`parentMessageId` is provided alongside a `branchReason`, the new
message is a sibling branch rather than a continuation, and the
conversation's `active_leaf_message_id` advances to the new assistant
leaf.

## Input

| Field             | Type                                                                 | Notes                                                 |
| ----------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| `conversationId`  | `string \| null`                                                     | `null` starts a new conversation.                     |
| `agentVersionId`  | `string \| null`                                                     | `null` uses the workspace default agent.              |
| `parentMessageId` | `string \| null`                                                     | Parent to attach to; `null` means root.               |
| `branchReason`    | `"edit" \| "regenerate" \| "tool_retry" \| "manual_fork" \| null`    | Non-null only when forking from a non-tip parent.     |
| `content`         | `string` (min 1)                                                     | Plain text content.                                   |
| `contentBlocks`   | `unknown[]`                                                          | Vercel AI SDK content-block array; defaults to `[]`.  |

## Output

| Field                  | Type     | Notes                                                                 |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| `conversationId`       | `string` | Resolved or newly-created.                                            |
| `userMessageId`        | `string` | The persisted user message id.                                        |
| `assistantMessageId`   | `string` | The persisted assistant message id (terminal id after stream closes). |
| `activeLeafMessageId`  | `string` | Mirrors `chat.conversations.active_leaf_message_id`.                  |

## Side effects

- Postgres: insert `chat.messages` (user), insert `chat.messages` (assistant), update `chat.conversations.active_leaf_message_id`; insert `chat.conversations` when starting a new thread.
- ClickHouse: emit one `token_usage` row per assistant turn; emit `events` rows for tool calls.
- Neo4j: upsert `(:Message)-[:REPLIES_TO]->(:Message)` and `(:Conversation)-[:CONTAINS]->(:Message)`; embed assistant message into `message_embedding_index`.

## Errors

| code                  | meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `conversation_missing`| Provided `conversationId` does not resolve in the workspace.         |
| `parent_missing`      | `parentMessageId` does not exist within the conversation.            |
| `branch_reason_required` | Parent is not the active leaf yet no `branchReason` was supplied. |
| `agent_unavailable`   | Default or requested agent version is disabled.                      |

## SPEC references

- §6.9 — `chat` schema and branching semantics
- §8 — Neo4j chat edges
- §15.2 — Inngest orchestration for async work
