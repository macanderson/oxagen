# video.generate

**Domain:** video
**Mode:** sync (queues an async render)
**Scope:** tenant + workspace
**Status:** live — async Veo/Sora render pipeline via Inngest

## Intent

Generate a short video from a natural-language prompt. The handler creates a
`pending` `generated_assets` row, dispatches the `agent/video.render` Inngest
job (which generates via the Vercel AI Gateway, uploads to blob storage, and
flips the row to `ready`), and returns a queued-job reference plus a render
directive that tells the chat UI to display the `video-result` component,
which polls the serving URL until the render lands.

## Duration snapping

Video models support only a discrete set of output durations (Veo 3: 4, 6, or
8 s; Sora 2: 4, 8, or 12 s). Requests are snapped rather than rejected:

- A requested duration the model doesn't support snaps to the **nearest**
  supported value (ties resolve to the longer clip).
- An absent duration selects the model's **shortest** supported value.
- The render always proceeds; when a request was adjusted the output carries a
  `durationAdjustment` object (and a human-readable `render.props.notice`)
  listing alternative models — with their supported durations — that get
  closer to the original ask, so the agent/UI can offer a re-render via the
  `model` input.
- Billing and telemetry always use the **effective** (snapped) duration.

The snapping logic lives in `@oxagen/ai` (`resolveVideoDurationSeconds`,
`supportedVideoDurations`, `videoDurationAlternatives`) and is applied both in
the handler (for messaging) and inside `generateVideoFor` (the enforcement
chokepoint every render passes through).

## Input

| Field             | Type                                   | Notes                                                                          |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `prompt`          | `string` (min 1)                       | Natural-language description of the video to generate.                         |
| `durationSeconds` | `integer` 1–60 (optional)              | Requested duration; snapped to the model's supported set (see above).          |
| `aspectRatio`     | `"16:9" \| "9:16" \| "1:1"` (optional) | Target aspect ratio for the output.                                            |
| `style`           | `string` (optional)                    | Free-text style hint for the rendering model (e.g. "cinematic", "animated").   |
| `model`           | `string` (optional)                    | Explicit gateway video model id (e.g. `openai/sora-2`); defaults to basic tier. |

## Output

| Field                | Type                          | Notes                                                                    |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `status`             | `"queued"` (literal)          | Always `"queued"` — the render is asynchronous.                          |
| `jobId`              | `string`                      | Opaque job identifier (the generated_assets public id).                  |
| `serveUrl`           | `string`                      | Access-controlled serving URL; 404 until the render lands.               |
| `durationAdjustment` | object (optional)             | Present when the requested duration was snapped; see below.              |
| `render`             | `RenderDirective`             | Instructs the chat stream route to render `video-result`.                |

### durationAdjustment

| Field              | Type       | Notes                                                            |
| ------------------ | ---------- | ---------------------------------------------------------------- |
| `requestedSeconds` | `number`   | The caller's original request.                                   |
| `effectiveSeconds` | `number`   | The duration actually rendered (and billed).                     |
| `supportedSeconds` | `number[]` | The selected model's full supported set.                         |
| `alternatives`     | array      | Other models ranked by closeness: `{ model, supportedSeconds, closestSeconds }`. |

### RenderDirective

| Field         | Type             | Notes                                                            |
| ------------- | ---------------- | ---------------------------------------------------------------- |
| `componentId` | `"video-result"` | Stable registry key — never rename.                              |
| `props`       | object           | `{ url, prompt, notice? }` — `notice` is the adjustment message. |

## Chat component

The render directive causes the chat stream route to emit a `"component"`
stream event with `componentId: "video-result"`. The message bubble dispatches
to `CHAT_COMPONENTS["video-result"]`, which lazy-loads
`apps/app/src/components/chat/registry-components/video-result.tsx`. The
component polls `serveUrl` (HEAD, 5 s interval) until the asset is ready, then
swaps in a `<video>` element; a `notice` prop renders as a banner above every
phase.

## Side effects

- Inserts a `pending` row in `content.generated_assets` (Postgres).
- Dispatches the `agent/video.render` Inngest event with the **effective**
  duration.
- The async worker uploads the render to Vercel Blob (private), flips the row
  to `ready`, writes a `token_usage` row to ClickHouse, and debits org credits
  for the effective duration.

## Errors

| Code               | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `400 Bad Request`  | Input failed Zod validation (empty prompt, invalid ratio, etc.)  |
| `401 Unauthorized` | No valid session or API key.                                     |
| `403 Forbidden`    | Caller lacks `video.generate` permission for the org/workspace.  |
| `500`              | `AI_GATEWAY_API_KEY` missing — generation unavailable.           |

Unsupported durations are **not** errors — they snap (see Duration snapping).

## SPEC references

- Capability contract: `packages/oxagen/src/contracts/video.generate.ts`
- Handler: `packages/handlers/src/video.generate.ts`
- Duration logic: `packages/ai/src/generate-video.ts`
- Render worker: `packages/inngest-functions/src/functions/agent.video-render.ts`
- Chat component: `apps/app/src/components/chat/registry-components/video-result.tsx`
- Rate card: `packages/billing/src/pricing.ts` (`VIDEO_RATE_CARD`)
