# conversation.purge

**Domain:** conversation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high (requires approval)

## Intent

Bulk soft-delete every archived conversation the caller owns in the active workspace. The scope is deliberately server-resolved — no IDs are provided; it targets "all my archived conversations here" in a single set-based `UPDATE`. Sets `deleted_at` on matched rows (retained for audit, never restorable from the product surface). The UI always shows a confirm dialog; the agent surface requires explicit approval.

This is distinct from `conversation.delete` (which targets specific IDs) and `conversation.archive` (which is reversible).

## Input

No fields. The caller's identity and workspace scope are derived from the authenticated session.

## Output

| Field | Type | Notes |
|---|---|---|
| `deleted` | `number` (int ≥ 0) | Count of archived conversations soft-deleted in this request. |

## Roles

Org Owner, Org Admin. Workspace Owner, Member.

## Side effects

- Postgres: `UPDATE conversations SET deleted_at = now() WHERE archived_at IS NOT NULL AND deleted_at IS NULL AND user_id = $caller AND workspace_id = $workspace`.
- Rows are retained with `deleted_at` set; they do not appear on any product surface.

## Surfaces

- `POST /v1/:org/:workspace/conversations/purge`
- MCP tool `conversation_purge` (requires approval)
- Agent: requires approval, risk `high`, category `conversation`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller lacks workspace Member role or higher. |
| `approval_required` | Agent surface invocation attempted without prior approval. |
