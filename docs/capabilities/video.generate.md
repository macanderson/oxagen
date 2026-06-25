# video.generate

**Domain:** video
**Mode:** sync
**Scope:** tenant + workspace
**Status:** stub — video rendering pipeline deferred

## Intent

Generate a short video from a natural-language prompt. The capability accepts
optional duration, aspect-ratio, and style parameters. It returns a
typed queued-job reference and a render directive that tells the chat UI to
immediately display the `make-video-form` component so the user can review,
edit, and re-submit the request once generation is live.

## Input

| Field             | Type                                   | Notes                                                                        |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| `prompt`          | `string` (min 1)                       | Natural-language description of the video to generate.                       |
| `durationSeconds` | `integer` 1–60 (optional)              | Duration of the output video in whole seconds.                               |
| `aspectRatio`     | `"16:9" \| "9:16" \| "1:1"` (optional) | Target aspect ratio for the output.                                          |
| `style`           | `string` (optional)                    | Free-text style hint for the rendering model (e.g. "cinematic", "animated"). |

## Output

| Field    | Type                 | Notes                                                               |
| -------- | -------------------- | ------------------------------------------------------------------- |
| `stub`   | `true` (literal)     | Always `true` for the stub implementation.                          |
| `status` | `"queued"` (literal) | Always `"queued"` for the stub.                                     |
| `jobId`  | `string`             | Opaque job identifier for future polling once the pipeline is live. |
| `render` | `RenderDirective`    | Instructs the chat stream route to render `make-video-form`.        |

### RenderDirective

| Field         | Type                 | Notes                                       |
| ------------- | -------------------- | ------------------------------------------- |
| `componentId` | `"make-video-form"`  | Stable registry key — never rename.         |
| `props`       | `MakeVideoFormProps` | Pre-populated form props echoed from input. |

## Chat component

The render directive causes the chat stream route to emit a `"component"`
stream event with `componentId: "make-video-form"`. The message bubble
dispatches to `CHAT_COMPONENTS["make-video-form"]`, which lazy-loads
`apps/app/src/components/chat/registry-components/make-video-form.tsx`.

The component renders a fully accessible form with:

- Prompt textarea (pre-filled from `render.props.prompt`)
- Duration number input (1–60 s)
- Aspect-ratio select (`16:9`, `9:16`, `1:1`)
- Style text input (optional)
- "Generate video" submit button (disabled while submitting / when prompt is empty)
- A "Coming soon — preview" badge so users understand generation is not yet live
- A queued-confirmation state after successful submit

The submit calls `videoGenerateAction` (a Next.js server action at
`apps/app/src/app/actions/video.generate.action.ts`) which re-validates the
input, delegates to `videoGenerateHandler`, and returns
`{ ok: true, queued: true, jobId }`.

## Side effects

None — stub logs intent to stdout. No DB write, no job queue, no billing charge.

## Errors

The handler does not throw. On validation failure, the Hono route returns
`400 Bad Request`; the server action returns `{ ok: false, error: string }`.

| Code               | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `400 Bad Request`  | Input failed Zod validation (empty prompt, invalid ratio, etc.) |
| `401 Unauthorized` | No valid session or API key.                                    |
| `403 Forbidden`    | Caller lacks `video.generate` permission for the org/workspace. |

## SPEC references

- Capability contract: `packages/oxagen/src/contracts/video.generate.ts`
- Handler: `packages/handlers/src/video.generate.ts`
- API route: `apps/api/src/routes/v1/video.generate.ts`
- Chat component: `apps/app/src/components/chat/registry-components/make-video-form.tsx`
- Server action: `apps/app/src/app/actions/video.generate.action.ts`
