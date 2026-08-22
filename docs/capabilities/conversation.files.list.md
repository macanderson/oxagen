# conversation.files.list

**Domain:** conversation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List the ready generated assets (images, videos, documents, etc.) associated
with a given conversation, scoped to the calling user's org and workspace.
Assets are returned newest-first, keyset-paginated, and filtered by access
policy: `user`-policy assets are only visible to their creator; `org`- and
`public`-policy assets are visible to any org member.

## Input

| Field            | Type                                                                                                       | Notes                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `conversationId` | `string`                                                                                                   | Public ID of the conversation whose files to list.                                                      |
| `kind`           | `"image" \| "video" \| "document" \| "spreadsheet" \| "presentation" \| "pdf" \| "archive"` (optional)   | Filter by asset kind. Omit to include all kinds.                                                        |
| `limit`          | `number` (1–200)                                                                                           | Page size. Defaults to 50.                                                                              |
| `cursor`         | `string \| null`                                                                                           | ISO `createdAt` of the last row from the previous page. Null starts at the newest file.                 |

## Output

| Field        | Type                                                                                                                                         | Notes                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `files`      | `Array<{ publicId, kind, name, mimeType, sizeBytes, status, accessPolicy, createdAt, url }>`                                                 | Page of asset items, newest first. `sizeBytes` is null until async renders complete. |
| `nextCursor` | `string \| null`                                                                                                                             | Cursor for the next page. Null when this is the last page.             |

### ConversationAssetItem

The canonical exported type is `ConversationAssetItem` from
`@oxagen/oxagen/contracts/conversation.files.list`. Import it instead of
redeclaring the shape in consuming code.

## Surfaces

- **API:** `GET /v1/:org/:workspace/conversations/:conversationId/files?kind=&limit=&cursor=`
- **MCP:** `conversation.files.list` tool (read-only, idempotent)
- **Agent:** invoked directly via `invoke("conversation.files.list", ...)` — no approval required

## Access control

- Caller must be an authenticated workspace member.
- The conversation must belong to the caller's org + workspace (enforced via tenant DB scope).
- `user`-policy assets are filtered in-process to the asset's creator only.
- `org`- and `public`-policy assets are visible to all org members.

## Side effects

None — read-only against PostgreSQL via `generated_assets_conversation_idx`.

## Errors

| code               | meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `unauthorized`     | Caller lacks workspace Member role or higher.              |
| `not_found`        | Conversation not found or not in caller's org scope.       |
| `validation_error` | Input failed Zod parse (e.g., unknown kind, limit out of range). |
