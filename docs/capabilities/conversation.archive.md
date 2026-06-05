# conversation.archive

**Domain:** conversation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Archive or restore one or more conversations in a single set-based update.
Archiving sets `archived_at`; restoring clears it. Because the operation is
fully reversible (no data is lost), the UI runs it without a confirm dialog
and the agent surface does not require approval. Archived conversations are
hidden from the active history list but remain accessible via
`conversation.list` with `filter: "archived"` and can be restored at any time.

This is distinct from `conversation.delete`, which is the irreversible
soft-delete path.

## Input

| Field             | Type                                 | Notes                                                              |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `conversationIds` | `string[]` (1–100 items)             | List of `cnv_` public ids to update.                               |
| `archived`        | `boolean`                            | `true` archives (sets `archived_at`); `false` restores (clears it). |

## Output

| Field     | Type     | Notes                                  |
| --------- | -------- | -------------------------------------- |
| `updated` | `number` | Count of rows updated in this request. |

## Surfaces

- **API:** `POST /v1/:org/:workspace/conversations/archive`
- **MCP:** `conversation.archive` tool (non-destructive, idempotent)
- **Agent:** invoked directly via `invoke("conversation.archive", ...)` — no approval required

## Side effects

Writes `archived_at` on the matched `conversations` rows in PostgreSQL.
Rows with `deleted_at` set are excluded server-side.

## Errors

| code               | meaning                                            |
| ------------------ | -------------------------------------------------- |
| `unauthorized`     | Caller lacks workspace Member role or higher.      |
| `validation_error` | Input failed Zod parse (e.g., empty id list).      |
