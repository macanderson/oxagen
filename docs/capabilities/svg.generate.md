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

The sanitized SVG is also persisted as a conversation file: an org-visible
`generated_assets` row (kind `image`, `image/svg+xml`) uploaded to blob
storage via `persistGeneratedAsset`, with conversation linkage resolved from
the chat turn's `messageId`, so it appears in the Conversation Files panel.
Persistence is strictly non-fatal — when it is skipped (generation failed /
no user identity) or fails, the inline result still returns and the output
carries a `persistWarning`. The failure-placeholder SVG is never persisted.

## Input

| Field    | Type                 | Notes                                                                   |
| -------- | -------------------- | ----------------------------------------------------------------------- |
| `prompt` | `string` (min 1)     | Natural-language description of the SVG to generate.                    |
| `title`  | `string` (optional)  | Optional title — used as `<title>` and in the chat card heading.        |
| `width`  | `number` (optional)  | Width hint in pixels. Defaults to 400.                                  |
| `height` | `number` (optional)  | Height hint in pixels. Defaults to 400.                                 |

## Output

| Field           | Type                 | Notes                                                                    |
| --------------- | -------------------- | ------------------------------------------------------------------------ |
| `svg`           | `string` (min 1)     | Sanitized inline SVG markup, ready for display in the `svg-preview` component. |
| `title`         | `string` (min 1)     | Human-readable title for the graphic.                                   |
| `assetPublicId` | `string` (optional)  | `gen_…` id of the persisted SVG asset. Absent when persistence was skipped or failed. |
| `serveUrl`      | `string` (optional)  | Access-controlled serving URL (`/api/v1/assets/{publicId}`) for the persisted SVG file. |
| `persistWarning`| `string` (optional)  | Present when the SVG could not be saved to conversation files (inline result unaffected). |
| `render`        | `RenderDirective`    | `{ componentId: "svg-preview", props: { svg, title, serveUrl?, assetPublicId? } }` — wires the chat render pipeline. |

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
- Blob storage + Postgres: one `generated_assets` row (`image` kind,
  `image/svg+xml`, org access policy) holding the sanitized markup, linked to
  the conversation.

## Serving & display security

The asset serving route forces `Content-Disposition: attachment` for
`image/svg+xml` — inline SVG served from our own origin is a stored-XSS
vector. UI surfaces (the `svg-preview` chat card and the Conversation Files
panel) therefore display persisted SVGs exclusively through `<img>` elements,
which ignore Content-Disposition and never execute scripts; downloads use the
HTML `download` attribute. Never render stored SVG markup with
`dangerouslySetInnerHTML`.

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
