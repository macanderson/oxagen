# conversation.export

**Domain:** conversation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Export an entire conversation as a portable document. The export follows the
currently active message branch (walking parent links from the conversation's
active leaf to the root); when the conversation has edited/regenerated
branches, a note records how many messages exist across all branches.

Two formats:

- **markdown** — the serialized document is returned inline (no storage).
  Title header + export metadata, then one section per message: role heading,
  text blocks verbatim, reasoning in a collapsible `<details>` block, tool
  calls as compact fenced summaries (capability, status, duration — full
  results only when tiny), code blocks fenced with their language, and
  attachments as links to their access-controlled serve URLs.
- **pdf** — a formatted PDF rendered with pdf-lib (A4, ~54pt margins, cover
  title block with org/workspace and message count, role-accented message
  blocks, monospace code/tool panels on light-gray rounded rects, page-number
  footers). The PDF is persisted as a **private** generated asset
  (`accessPolicy: "user"`) that is deliberately **not** linked to the
  conversation, so it never appears in the Conversation Files panel; the
  response carries its access-controlled serve URL.

## Input

| Field            | Type                      | Notes                                          |
| ---------------- | ------------------------- | ---------------------------------------------- |
| `conversationId` | `string`                  | Public ID of the conversation to export.       |
| `format`         | `"markdown" \| "pdf"`     | Export format.                                 |

## Output

| Field          | Type               | Notes                                                              |
| -------------- | ------------------ | ------------------------------------------------------------------ |
| `format`       | `"markdown" \| "pdf"` | Echoes the requested format.                                    |
| `filename`     | `string`           | Suggested download name, e.g. `quarterly-planning-2026-07-07.md`.  |
| `content`      | `string \| null`   | The Markdown source (markdown format only; null for pdf).          |
| `url`          | `string \| null`   | `/api/v1/assets/:publicId` serve URL (pdf format only; null for markdown). |
| `messageCount` | `number`           | Messages on the exported (active) branch.                          |

## Surfaces

- **API:** `GET /v1/:org/:workspace/conversations/:conversationId/export?format=markdown|pdf`
- **MCP:** `conversation.export` tool
- **Agent:** invoked directly via `invoke("conversation.export", ...)` — no approval required
- **App:** `ConversationExportMenu` component → `GET /api/v1/conversations/:conversationId/export`

## Access control

- Caller must be an authenticated workspace member.
- The conversation must belong to the caller's org + workspace (enforced via
  tenant DB scope; the app route additionally verifies org membership before
  invoking).
- The generated PDF asset is private to the requester (`accessPolicy: "user"`),
  served only through the auth-gated `/api/v1/assets/:publicId` route.

## Side effects

- `markdown`: none — read-only serialization.
- `pdf`: uploads the rendered PDF to blob storage and inserts one
  `content.generated_assets` row with `conversation_id = NULL` and
  `message_id = NULL` (intentionally unlinked from the conversation).

## Billing

`noBillingGate: true` — exports consume no AI tokens (mirrors
`conversation.files.list`).

## Errors

| code               | meaning                                                  |
| ------------------ | -------------------------------------------------------- |
| `unauthorized`     | Caller lacks workspace Member role or higher.            |
| `not_found`        | Conversation not found or not in caller's org scope.     |
| `validation_error` | Input failed Zod parse (e.g., unknown format).           |
