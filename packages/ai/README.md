# @oxagen/ai — Single AI Chokepoint

Every LLM call in the platform — streaming completions, structured object generation, embeddings, image and video generation — goes through this package's helpers, so metering, performance tracking, and customer billing happen in exactly one place.

## What this is

`@oxagen/ai` wraps the Vercel AI SDK calls the platform makes — `streamText`, `generateObject`, `embed`, `generateImage`, and `experimental_generateVideo` — behind a typed facade. Callers receive the same streaming and structured-output ergonomics as the raw SDK, but the boundary layer automatically:

- Records token usage and latency to `@oxagen/telemetry`
- Writes usage to `@oxagen/billing` for credit metering
- Selects the model from a centrally maintained catalog so model IDs are never scattered across the codebase

IAM checks happen earlier, at the capability kernel's `invoke()` boundary (`packages/oxagen`), before a handler ever calls into this package.

```
caller → capability handler → @oxagen/ai helper [meter · telemetry] → provider (Anthropic / OpenAI / Google) → usage → billing
```

## Install / import

Workspace-internal package. Add `"@oxagen/ai": "workspace:*"` to the consuming package's dependencies.

## Exports

| Subpath | Provides |
|---|---|
| `.` | Root barrel — `streamAgentReply`, `generateObjectFor`, `generateImageFor`, `generateVideoFor`, `embedText`, `submitBatch` / `pollBatch`, the prompt registry, and the model selectors |
| `./catalog` | Typed model catalog — `gatewayModels`, tier helpers, capability flags |
| `./posture` | Provider capability posture matrix — cache/reasoning/structured-output/attachment support per vendor |
| `./slash-commands` | Chat slash-command registry, client-safe |
| `./mentions` | `@`-mention reference grammar (parse/serialize/render), client-safe |

## Model catalog

Model IDs are maintained in `src/catalog.ts`. The catalog is the single source of truth for what a model can do (the `capabilities` array). The concrete model each tier resolves to is owned by the `OXAGEN_LLM_*` env vars (server-only, see `./models.ts`).

| Tier | Env var | Default |
|---|---|---|
| `fast` | `OXAGEN_LLM_FAST` | `anthropic/claude-haiku-4.5` |
| `balanced` | `OXAGEN_LLM_BALANCED` | `anthropic/claude-sonnet-5` |
| `precise` | `OXAGEN_LLM_PRECISE` | `anthropic/claude-fable-5` |
| `image.basic` | `OXAGEN_LLM_IMAGE_BASIC` | `openai/gpt-image-1` |
| `image.advanced` | `OXAGEN_LLM_IMAGE_ADVANCED` | `bfl/flux-2-max` |
| `video.basic` | `OXAGEN_LLM_VIDEO_BASIC` | `google/veo-3.0-fast-generate-001` |
| `video.advanced` | `OXAGEN_LLM_VIDEO_ADVANCED` | `google/veo-3.0-generate-001` |

## Source layout

- `src/stream.ts` — `streamAgentReply()`: wraps `streamText`; enforces IAM, meters tokens, emits telemetry
- `src/generate-object.ts` — `generateObjectFor()`: structured output via Zod schema; same boundary guarantees as stream
- `src/generate-image.ts` — `generateImageFor()`: image generation; meters by image count and size
- `src/generate-video.ts` — `generateVideoFor()`: video generation; meters by asset and duration
- `src/embed.ts` — `embedText()`: text embedding via `text-embedding-3-small`; meters embedding tokens
- `src/models.ts` — `selectModel()`, `selectImageModel()`, `selectVideoModel()`: gateway model factories; reads tier env vars
- `src/catalog.ts` — `gatewayModels` constant and capability helpers; client-safe (no provider SDK imports)
- `src/load-effective-model-defaults.ts` — server-only; loads user + workspace model preferences from the DB
- `src/resolve-model-defaults.ts` — pure resolver for model defaults; client-safe
- `src/provider-posture.ts` — per-vendor capability posture matrix (cache/reasoning/structured-output/attachments); client-safe
- `src/cache.ts` — opt-in exact + semantic response cache for deterministic background inference
- `src/batch.ts` — Anthropic Message Batches (background inference at half price)
- `src/prompts/` — prompt registry, slash commands, and `@`-mention grammar
- `src/index.ts` — root barrel re-exporting the public helpers

## Dependencies

**External:** `ai@7.0.14`, `@ai-sdk/gateway`, `@ai-sdk/provider`, `@ai-sdk/openai-compatible`, `@anthropic-ai/sdk`, `@opentelemetry/api`, `zod`, `drizzle-orm`

**Workspace:** `@oxagen/config`, `@oxagen/telemetry`, `@oxagen/billing`, `@oxagen/database`, `@oxagen/tenancy`

**Consumed by:** `@oxagen/agent`, `@oxagen/handlers`, `apps/app`, `apps/api`, `apps/mcp`

## Scripts

| Command | Does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test:unit` | Vitest unit suite |
| `pnpm test:coverage` | Vitest with v8 coverage report |

## Design notes

**Why does the chokepoint exist?**

With no single boundary, metering drifts apart. One caller bills correctly, the next forgets to record tokens, a third calls a provider with no IAM check at all. Every surface — app, API, MCP, CLI — has to bill the same way, and the only reliable way to get that is to make every call go down the same path. Add a new surface and it inherits metering for free.

**Can I call the Vercel AI SDK directly in a handler?**

No. Calling `streamText`, `generateObject`, `generateText`, or `embed` straight from `ai` — or reaching for a provider SDK — skips metering, so the org is never billed for that call. Use the helpers this package exports instead.

Importing the SDK for its *types* (`ModelMessage`, `ToolSet`, `Tool`) is fine, and so is `tool` / `jsonSchema` / `stepCountIs`; this package re-exports those three from its root barrel so tool-building code does not need its own `ai` import.

This rule is a convention, not a gate: nothing in ESLint or CI fails a build that imports the call functions directly. Check by hand in review.

**Which credentials reach a provider.**

The Vercel AI Gateway (`@ai-sdk/gateway`) is the default path for every call type, and `AI_GATEWAY_API_KEY` is the only credential it needs. Two paths deliberately leave it:

- Set `OXAGEN_MODEL_PROVIDER=openrouter` and *language* calls go straight to OpenRouter with `OPENROUTER_API_KEY`. This is an explicit operator opt-out for a deployment that cannot reach the gateway — never an automatic failover, because a silent failover would move spend onto another vendor's bill and skip the metering the gateway exists to provide. Image, video, and embedding calls stay on the gateway and therefore still fail on such a deployment, visibly.
- `submitBatch` / `pollBatch` go straight to Anthropic with `ANTHROPIC_API_KEY`, because the gateway does not proxy the Message Batches endpoint. These calls are metered here, in `src/batch.ts`, the same way the synchronous helpers are.
