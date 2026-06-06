# image.generate

**Domain:** image
**Mode:** sync
**Scope:** tenant + workspace

## Intent

Generate an image from a natural-language prompt via the Vercel AI Gateway
(default model `openai/gpt-image-1`).

When `AI_GATEWAY_API_KEY` is not configured, the handler returns a typed
placeholder result with a render directive that shows an empty-state in
the `image-preview` chat component — it never throws (policy §0.5).

Returns the image URL or data URI, alt text, a `placeholder` flag, and a
render directive for the `image-preview` chat component.

## Input

| Field    | Type                                                              | Notes                                              |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `prompt` | `string` (min 1)                                                  | Natural-language description of the image.        |
| `alt`    | `string` (optional)                                               | Accessible alt text. Derived from prompt if omitted. |
| `size`   | `"1024x1024" \| "1792x1024" \| "1024x1792"` (default `1024x1024`) | Image dimensions supported by the gateway default model. |

## Output

| Field      | Type                | Notes                                                                        |
| ---------- | ------------------- | ---------------------------------------------------------------------------- |
| `url`      | `string` (optional) | Public URL of the generated image. Present on success when provider returns a URL. |
| `dataUri`  | `string` (optional) | Base-64 `data:image/png;base64,...` URI. Present when provider returns bytes. |
| `alt`      | `string`            | Accessible alt text for the image.                                           |
| `placeholder` | `boolean`        | `true` when generation was skipped (no key) or failed.                       |
| `render`   | `RenderDirective`   | `{ componentId: "image-preview", props: { url?, dataUri?, alt, placeholder } }` |

## Behaviour without AI_GATEWAY_API_KEY

When the key is absent (or `requireEnv` throws), the handler returns:

```json
{
  "alt": "<derived from prompt>",
  "placeholder": true,
  "render": {
    "componentId": "image-preview",
    "props": { "placeholder": true, "alt": "..." }
  }
}
```

The `image-preview` component renders an empty-state card with the message
"Image generation is not enabled."

## Side effects

None when `placeholder: true`. On successful generation: no telemetry is
written by this handler (the AI SDK image call does not go through
`generateObjectFor`). A future iteration should add a ClickHouse write.

## Errors

The handler never throws. On generation failure it returns `placeholder: true`.

| code              | meaning                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `400 Bad Request` | Input failed Zod validation (empty prompt, invalid size).         |
| `401 Unauthorized`| No valid session or API key.                                      |
| `403 Forbidden`   | Caller lacks `image.generate` permission for the org/workspace.   |

## SPEC references

- Chat component registry — `apps/app/src/components/chat/chat-component-registry.tsx`
- Image preview component — `apps/app/src/components/chat/registry-components/image-preview.tsx`
