# conversation.attachment.add

**Domain:** conversation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Billing:** not gated (linking a file record consumes no AI tokens)

## Intent

Link an already-stored asset to a conversation as a chat attachment. This is
the second half of the "attach a file to chat" flow: the client uploads the
bytes once (e.g. via `asset.upload` with `source: "user_upload"`), then calls
this capability with the returned `assetPublicId` to point the asset's
`conversation_id` at the target conversation — making it appear in
`conversation.files.list` and the message thread.

No bytes move: the asset already lives in blob storage and is referenced by its
`generated_assets` row (four-store model). Only the conversation linkage column
is updated.

## Input

| Field            | Type     | Notes                                                                                             |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `conversationId` | `string` | Public ID of the conversation to attach the asset to. Must be in the caller's org + workspace.    |
| `assetPublicId`  | `string` | Public ID (`gen_…`) of an already-uploaded/generated asset. Must be `status: "ready"` and belong to the caller. |

## Output

The canonical `ConversationAssetItem` shape (reused from
`conversation.files.list`):

| Field          | Type                                | Notes                                              |
| -------------- | ----------------------------------- | -------------------------------------------------- |
| `publicId`     | `string`                            | Asset public ID.                                   |
| `kind`         | asset kind enum                     | `image \| video \| document \| spreadsheet \| presentation \| pdf \| archive`. |
| `name`         | `string`                            | Derived, URL-friendly filename with extension.     |
| `mimeType`     | `string`                            | Stored MIME type.                                  |
| `sizeBytes`    | `number \| null`                    | Null until an async render completes.              |
| `status`       | `string`                            | `ready`.                                           |
| `accessPolicy` | `"user" \| "org" \| "public"`       | The asset's visibility policy.                     |
| `createdAt`    | `string` (ISO)                      | Asset creation timestamp.                          |
| `url`          | `string`                            | Access-controlled serving URL (`/api/v1/assets/:publicId`). |

## Surfaces

- **API:** `POST /v1/:org/:workspace/conversations/attachments` — body `{ conversationId, assetPublicId }`
- **MCP:** `conversation.attachment.add` tool (idempotent)
- **Agent:** invoked via `invoke("conversation.attachment.add", ...)` — no approval required

## Access control

- Caller must be an authenticated workspace member.
- The conversation must belong to the caller's org + workspace.
- The asset must belong to the caller's org + workspace and be `ready`.
- A `user`-policy (private) asset can only be attached by its owner; `org`- and
  `public`-policy assets can be attached by any org member.

## Side effects

- Postgres: one `generated_assets` update setting `conversation_id`. Idempotent —
  re-attaching the same asset to the same conversation is a no-op that still
  returns the record.
- No blob writes, no ClickHouse/Neo4j writes (beyond the standard kernel
  security event).

## Errors

| code               | meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `unauthorized`     | No authenticated user.                                     |
| `not_found`        | Conversation or asset not found / out of scope, or a private asset not owned by the caller. |
| `not_ready`        | The asset is not in `status: "ready"`.                     |
| `validation_error` | Input failed Zod parse.                                    |
