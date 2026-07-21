# mermaid.generate

**Domain:** mermaid
**Mode:** sync
**Scope:** tenant + workspace

## Intent

Produce a Mermaid diagram from validated source text and return a render directive
so the output renders inline in chat via the `mermaid-diagram` client component.

The handler performs server-side validation only (non-empty source, 50,000-character cap).
No server-side rendering is done — Mermaid renders the diagram to SVG entirely in the
browser, satisfying the serverless pure-JS constraint. All diagram types supported by
Mermaid v11 are accepted: flowcharts, sequence diagrams, class diagrams, Gantt charts,
state diagrams, ER diagrams, and more.

Because the rendered SVG only ever exists client-side, the durable conversation-file
artifact is the diagram **source** itself: the handler persists it as a `.mmd` document
asset (`text/vnd.mermaid`, kind `document`, org access policy) via
`persistGeneratedAsset`, so it appears in the Conversation Files panel (conversation
linkage resolves from the chat turn's `messageId`). Persistence is strictly non-fatal —
when it is skipped (no user identity) or fails, the inline render still succeeds and the
output carries a `persistWarning`.

## Input

| Field     | Type                                                   | Notes                                                         |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| `title`   | `string` (min 1, max 200)                              | Human-readable title shown in the card heading.               |
| `diagram` | `string` (min 1, max 50,000)                           | Mermaid diagram source text.                                   |
| `theme`   | `'default' \| 'dark' \| 'neutral' \| 'forest'` (opt) | Mermaid rendering theme. Defaults to `'default'`.             |

## Output

| Field           | Type                | Notes                                                                                                            |
| --------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `title`         | `string` (min 1)    | Human-readable title passed through from input.                                                                  |
| `source`        | `string` (min 1)    | Validated Mermaid source text.                                                                                   |
| `assetPublicId` | `string` (optional) | `gen_…` id of the persisted `.mmd` source asset. Absent when persistence was skipped or failed.                  |
| `serveUrl`      | `string` (optional) | Access-controlled serving URL (`/api/v1/assets/{publicId}`) for the persisted source file.                        |
| `persistWarning`| `string` (optional) | Present when the source could not be saved to conversation files (inline render unaffected).                     |
| `render`        | `RenderDirective`   | `{ componentId: "mermaid-diagram", props: { source, title, theme, sourceUrl?, assetPublicId? } }` — wires the chat render pipeline. |

## Validation

- `title` must be between 1 and 200 characters.
- `diagram` must be non-blank and at most 50,000 characters. No structural validation
  of Mermaid syntax is performed server-side — syntax errors surface as client-side
  render errors with a friendly fallback UI.

## Surfaces

Available on API, MCP, and agent surfaces.

## Chat component

`mermaid-diagram` — lazily loads the `mermaid` npm package and renders the source to
SVG client-side. Shows a loading spinner while rendering, and a friendly error card if
the source is malformed. Supports source view toggle, clipboard copy, and — when the
handler persisted the source (`sourceUrl` prop present) — downloading the `.mmd` file.

## Side effects

- Blob storage + Postgres: one `generated_assets` row (`document` kind,
  `text/vnd.mermaid`) holding the `.mmd` source and linked to the conversation.

## Example (flowchart)

**Input:**
```json
{
  "title": "Auth Flow",
  "diagram": "flowchart TD\n  User-->Login\n  Login-->|valid|Dashboard\n  Login-->|invalid|Error",
  "theme": "default"
}
```

**Output:**
```json
{
  "title": "Auth Flow",
  "source": "flowchart TD\n  User-->Login\n  Login-->|valid|Dashboard\n  Login-->|invalid|Error",
  "render": {
    "componentId": "mermaid-diagram",
    "props": {
      "source": "flowchart TD\n  User-->Login\n  Login-->|valid|Dashboard\n  Login-->|invalid|Error",
      "title": "Auth Flow",
      "theme": "default"
    }
  }
}
```
