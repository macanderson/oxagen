# conversation.delete

**Domain:** conversation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high

## Intent

Permanently delete one or more conversations from the user's view via
soft-delete: sets `deleted_at` on each matched row. The rows are retained in
PostgreSQL for SOC2 and audit purposes but disappear from every product
surface — both the active and archived history lists — and cannot be restored
through any product action.

Because the operation is irreversible from the user's perspective:

- The **UI always gates it behind a confirm dialog** before calling this endpoint.
- The **agent surface requires explicit approval** (`requiresApproval: true`,
  `riskLevel: "high"`) before the kernel dispatches the handler.

For a reversible alternative, use `conversation.archive`.

## Input

| Field             | Type                     | Notes                                         |
| ----------------- | ------------------------ | --------------------------------------------- |
| `conversationIds` | `string[]` (1–100 items) | List of `cnv_` public ids to soft-delete.     |

## Output

| Field     | Type     | Notes                                           |
| --------- | -------- | ----------------------------------------------- |
| `deleted` | `number` | Count of rows marked deleted in this request.   |

## Surfaces

- **API:** `POST /v1/:org/:workspace/conversations/delete`
- **MCP:** `conversation.delete` tool (destructive, non-idempotent)
- **Agent:** invoked via `invoke("conversation.delete", ...)` — **approval required before dispatch**

## Side effects

Writes `deleted_at` on the matched `conversations` rows in PostgreSQL.
Already-deleted rows are excluded server-side (idempotent at the row level
but counted only for rows actually updated).

## Audit retention

Soft-deleted rows remain in the `conversations` table indefinitely. They are
excluded from all product-facing queries by an `IS NULL` filter on `deleted_at`
but remain accessible to internal audit tooling and SOC2 log exports.

## Errors

| code               | meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `unauthorized`     | Caller lacks workspace Member role or higher.               |
| `approval_required` | Agent surface call arrived without a resolved approval token. |
| `validation_error` | Input failed Zod parse (e.g., empty id list).               |
