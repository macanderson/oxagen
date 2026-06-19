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

## Input

| Field     | Type                                                   | Notes                                                         |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| `title`   | `string` (min 1, max 200)                              | Human-readable title shown in the card heading.               |
| `diagram` | `string` (min 1, max 50,000)                           | Mermaid diagram source text.                                   |
| `theme`   | `'default' \| 'dark' \| 'neutral' \| 'forest'` (opt) | Mermaid rendering theme. Defaults to `'default'`.             |

## Output

| Field    | Type              | Notes                                                                                                            |
| -------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `title`  | `string` (min 1)  | Human-readable title passed through from input.                                                                  |
| `source` | `string` (min 1)  | Validated Mermaid source text.                                                                                   |
| `render` | `RenderDirective` | `{ componentId: "mermaid-diagram", props: { source, title, theme } }` — wires the chat render pipeline.        |

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
the source is malformed. Supports source view toggle and clipboard copy.

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
