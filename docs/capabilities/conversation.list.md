# conversation.list

**Domain:** conversation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List a user's conversations in a workspace, filtered by active or archived
state, sorted newest-first, and keyset-paginated. Returns lean summary rows
(title, status, lifecycle timestamps) with no per-row message join, so
listing hundreds of conversations is a single indexed scan.

## Input

| Field    | Type                            | Notes                                                                 |
| -------- | ------------------------------- | --------------------------------------------------------------------- |
| `filter` | `"active" \| "archived"`        | Which conversations to return. Defaults to `"active"`.                |
| `limit`  | `number` (1–100)                | Page size. Defaults to 50.                                            |
| `cursor` | `string \| null`                | ISO `updated_at` of the last row from the previous page. Null starts at the newest row. |

## Output

| Field           | Type                                                                     | Notes                                                                 |
| --------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `conversations` | `Array<{ publicId, title, status, archivedAt, createdAt, updatedAt }>`   | Page of conversation summaries, newest first.                         |
| `nextCursor`    | `string \| null`                                                         | Cursor for the next page. Null when this is the last page.            |

## Surfaces

- **API:** `GET /v1/:org/:workspace/conversations?filter=&limit=&cursor=`
- **MCP:** `conversation.list` tool (read-only, idempotent)
- **Agent:** invoked directly via `invoke("conversation.list", ...)` — no approval required

## Side effects

None — read-only against PostgreSQL via the `conversations_list_idx` index.

## Errors

| code                   | meaning                                           |
| ---------------------- | ------------------------------------------------- |
| `unauthorized`         | Caller lacks workspace Member role or higher.     |
| `validation_error`     | Input failed Zod parse (e.g., limit out of range). |
