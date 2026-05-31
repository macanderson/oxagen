# svg.generate

**Domain:** svg
**Mode:** sync
**Scope:** tenant + workspace

## Intent

Generate clean, sanitized, inline SVG markup from a natural-language prompt
using the platform default language model. The SVG is designed to be
light/dark adaptive: strokes and fills use `currentColor` and CSS custom
properties, and optional CSS `@keyframes` animations are encouraged.

The handler strips `<script>` tags and `on*` event-handler attributes from
the model output before returning it. The chat component renders via
`<img src="data:image/svg+xml,...">` — never `dangerouslySetInnerHTML` —
providing a second layer of XSS defence.

Returns the sanitized SVG markup, a title, and a render directive so the
output renders inline in chat via the `svg-preview` component.

## Input

| Field    | Type                 | Notes                                                                   |
| -------- | -------------------- | ----------------------------------------------------------------------- |
| `prompt` | `string` (min 1)     | Natural-language description of the SVG to generate.                    |
| `title`  | `string` (optional)  | Optional title — used as `<title>` and in the chat card heading.        |
| `width`  | `number` (optional)  | Width hint in pixels. Defaults to 400.                                  |
| `height` | `number` (optional)  | Height hint in pixels. Defaults to 400.                                 |

## Output

| Field    | Type                 | Notes                                                                    |
| -------- | -------------------- | ------------------------------------------------------------------------ |
| `svg`    | `string` (min 1)     | Sanitized inline SVG markup, ready for display in the `svg-preview` component. |
| `title`  | `string` (min 1)     | Human-readable title for the graphic.                                   |
| `render` | `RenderDirective`    | `{ componentId: "svg-preview", props: { svg, title } }` — wires the chat render pipeline. |

## Sanitisation

Two passes:

1. **Handler (server-side):** `<script>...</script>` blocks, self-closing `<script/>` tags,
   and `on*="..."` attributes are stripped with regex before the result is returned.
2. **Component (client-side):** the `svg-preview` component encodes the SVG as a
   `data:image/svg+xml;charset=utf-8,...` URI and sets it as an `<img>` `src` — no
   `dangerouslySetInnerHTML` is used, so inline script execution is impossible at
   the browser level.

## Side effects

- ClickHouse: emits one `token_usage` row per call via `generateObjectFor`.
- Billing: debits org credits at the solved meter rate.

## Errors

The handler never throws. On model failure it returns a minimal placeholder SVG
with the text "SVG generation failed" so the render path always has a valid output.

| code              | meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `400 Bad Request` | Input failed Zod validation (empty prompt, non-positive dimension).|
| `401 Unauthorized`| No valid session or API key.                                       |
| `403 Forbidden`   | Caller lacks `svg.generate` permission for the org/workspace.      |

## SPEC references

- Chat component registry — `apps/app/src/components/chat/chat-component-registry.tsx`
- SVG preview component — `apps/app/src/components/chat/registry-components/svg-preview.tsx`
