# Spec: ai-media-and-models

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: generate-image.ts, generate-video.ts, catalog.ts, models.ts, resolve-model-defaults.ts, load-effective-model-defaults.ts
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Image generation executes via gateway and records telemetry

<!-- id: generateImageFor -->
<!-- entities: Organization, Workspace, Image -->
<!-- enforced: generateImageFor() -->
<!-- test: generateImageFor.test.ts -->

When a caller invokes `generateImageFor()` with an image model, prompt, and telemetry context, the function SHALL generate one or more images via the Vercel AI SDK `generateImage()` primitive, extract the base64-encoded results, measure wall-clock duration, and return the images with metadata.

#### Scenario: Single image generation succeeds
<!-- test: generateImageFor.test.ts → "returns the base64 images and the image count" -->
- **WHEN** `generateImageFor({ model, prompt, telemetry })` is called with `n` defaulting to 1
- **THEN** the result carries `images` (array of base64 strings), `imageCount` (1), and `durationMs` (wall-clock elapsed time)

#### Scenario: Custom size is passed through
<!-- test: generateImageFor.test.ts → "defaults size to 1024x1024 when the caller omits it" -->
- **WHEN** caller omits `size` parameter
- **THEN** size defaults to "1024x1024" for cost and telemetry calculations

---

### Requirement: Image generation records token_usage telemetry with real model id and image count

<!-- id: generateImageFor.insertTokenUsage -->
<!-- entities: Image, TokenUsage -->
<!-- depends_on: Image generation executes via gateway and records telemetry -->
<!-- enforced: generateImageFor() -->
<!-- test: generateImageFor.test.ts → "writes a token_usage row tagged with the REAL model id" -->

After successful image generation, the function SHALL insert a `token_usage` row into ClickHouse via `insertTokenUsage()`. The row MUST carry the real model id (not a sentinel), use `input_tokens` to hold the image count, set `output_tokens` and `cached_tokens` to 0, and include the real per-image provider cost in `cost_usd_micros`.

#### Scenario: Telemetry row structure for single image
- **WHEN** image generation completes with `imageCount = 1` and model = "bfl/flux-2-max"
- **THEN** token_usage row contains:
  - `model = "bfl/flux-2-max"` (real model id, not sentinel)
  - `input_tokens = 1` (image count repurposed)
  - `output_tokens = 0`, `cached_tokens = 0`
  - `prompt_hash = "image-generation"` (fixed sentinel for filtering)
  - `cost_usd_micros` = value from `imageProviderCostUsdMicros(modelId, imageCount, size)`
  - `execution_step_id`, `org_id`, `workspace_id`, `surface` from caller's telemetry context

---

### Requirement: Image generation charges organization credits post-call

<!-- id: generateImageFor.chargeImageCredits -->
<!-- entities: Organization, Image -->
<!-- depends_on: Image generation executes via gateway and records telemetry -->
<!-- enforced: generateImageFor() -->
<!-- test: generateImageFor.test.ts → "prices the real model + size and charges via chargeImageCredits" -->

After successful image generation and telemetry write, the function SHALL call `chargeImageCredits()` with the real model, image count, and size to debit the organization's credit balance at the platform markup.

#### Scenario: Image charge parameters
- **WHEN** generation completes with `model = "bfl/flux-2-max"`, `n = 1`, `size = "1536x1024"`
- **THEN** `chargeImageCredits()` is called with `{ orgId, referenceId (execution step id), model, imageCount, size }`

---

### Requirement: Image generation telemetry and credit failures are swallowed

<!-- id: generateImageFor.telemetry-resilience -->
<!-- entities: Image -->
<!-- depends_on: Image generation executes via gateway and records telemetry -->
<!-- enforced: generateImageFor() -->
<!-- test: generateImageFor.test.ts → "swallows an insertTokenUsage error and still returns images" -->

When `insertTokenUsage()` or `chargeImageCredits()` fails with any error, the function SHALL log the error and swallow it — the failure MUST NOT fail the caller's image generation request.

#### Scenario: Telemetry write fails but images return
- **WHEN** `insertTokenUsage()` raises an exception
- **THEN** the exception is logged at error level and images are still returned

#### Scenario: Credit charge fails but images return
- **WHEN** `chargeImageCredits()` raises an exception
- **THEN** the exception is logged at error level and images are still returned

---

### Requirement: Image generation provider errors are propagated

<!-- id: generateImageFor.provider-propagation -->
<!-- entities: Image -->
<!-- depends_on: Image generation executes via gateway and records telemetry -->
<!-- enforced: generateImageFor() -->
<!-- test: generateImageFor.test.ts → "propagates errors from generateImage (not swallowed)" -->

Errors from the Vercel AI SDK `generateImage()` call (provider auth, rate limit, model not found) MUST be propagated to the caller — they are not swallowed like telemetry errors.

#### Scenario: Provider error surfaces
- **WHEN** `generateImage()` throws an error
- **THEN** the error is not caught; it propagates to the caller

---

### Requirement: Video generation executes via gateway with 15-minute timeout

<!-- id: generateVideoFor -->
<!-- entities: Organization, Workspace, Video -->
<!-- enforced: generateVideoFor() -->
<!-- test: generateVideoFor.test.ts → "returns bytes and mimeType from the first generated video" -->

When a caller invokes `generateVideoFor()` with a video model, prompt, and telemetry context, the function SHALL generate a video via the Vercel AI SDK `experimental_generateVideo()` primitive with a 15-minute AbortSignal timeout (to prevent indefinite hangs during slow Veo renders), extract the first video's bytes and MIME type, measure wall-clock duration, and return the result.

#### Scenario: Video generation with duration and aspect ratio hints
<!-- test: generateVideoFor.test.ts → "passes prompt, duration, and aspectRatio through to experimental_generateVideo" -->
- **WHEN** caller provides `durationSeconds = 5` and `aspectRatio = "16:9"`
- **THEN** these are passed as `duration` and `aspectRatio` to `experimental_generateVideo()`; `maxRetries` is set to 0 (Inngest handles retry policy)

#### Scenario: MIME type defaults to video/mp4
<!-- test: generateVideoFor.test.ts → "defaults mimeType to video/mp4 when provider omits it" -->
- **WHEN** provider returns `video.mimeType = undefined`
- **THEN** result carries `mimeType = "video/mp4"`

---

### Requirement: Video generation records token_usage with asset count and duration-based cost

<!-- id: generateVideoFor.insertTokenUsage -->
<!-- entities: Video, TokenUsage -->
<!-- depends_on: Video generation executes via gateway with 15-minute timeout -->
<!-- enforced: generateVideoFor() -->
<!-- test: generateVideoFor.test.ts → "writes a token_usage row with the correct telemetry fields" -->

After successful video generation, the function SHALL insert a `token_usage` row into ClickHouse via `insertTokenUsage()`. The row MUST carry the real model id, use `input_tokens = 1` (asset count), set `output_tokens` and `cached_tokens` to 0, and include the provider cost (based on model and duration) in `cost_usd_micros`.

#### Scenario: Telemetry row for 5-second video
- **WHEN** video generation completes with duration = 5 seconds and model = "google/veo-3.0-fast-generate-001"
- **THEN** token_usage row contains:
  - `model = "google/veo-3.0-fast-generate-001"` (real model id)
  - `input_tokens = 1` (asset count)
  - `output_tokens = 0`, `cached_tokens = 0`
  - `prompt_hash = "video-generation"` (fixed sentinel)
  - `cost_usd_micros` = value from `videoProviderCostUsdMicros(modelId, durationSeconds)`
  - `org_id`, `workspace_id`, `surface`, `execution_step_id` from caller's context

---

### Requirement: Video generation charges organization credits post-call

<!-- id: generateVideoFor.chargeVideoCredits -->
<!-- entities: Organization, Video -->
<!-- depends_on: Video generation executes via gateway with 15-minute timeout -->
<!-- enforced: generateVideoFor() -->
<!-- test: generateVideoFor.test.ts → "charges the org's credits through the billing gate" -->

After successful video generation and telemetry write, the function SHALL call `chargeVideoCredits()` with the real model and duration to debit the organization's credit balance at the platform markup.

#### Scenario: Video charge parameters
- **WHEN** generation completes with `model = "google/veo-3.0-fast-generate-001"` and `durationSeconds = 5`
- **THEN** `chargeVideoCredits()` is called with `{ orgId, referenceId (execution step id), model, durationSeconds }`

---

### Requirement: Video generation telemetry and credit failures are swallowed

<!-- id: generateVideoFor.telemetry-resilience -->
<!-- entities: Video -->
<!-- depends_on: Video generation executes via gateway with 15-minute timeout -->
<!-- enforced: generateVideoFor() -->
<!-- test: generateVideoFor.test.ts → "swallows an insertTokenUsage error and still returns bytes" -->

When `insertTokenUsage()` or `chargeVideoCredits()` fails with any error, the function SHALL log the error and swallow it — the failure MUST NOT fail the caller's video generation request.

#### Scenario: Telemetry write fails but bytes return
- **WHEN** `insertTokenUsage()` raises an exception
- **THEN** the exception is logged at error level and bytes are still returned

#### Scenario: Credit charge fails but bytes return
- **WHEN** `chargeVideoCredits()` raises an exception
- **THEN** the exception is logged at error level and bytes are still returned

---

### Requirement: Video generation provider errors are propagated

<!-- id: generateVideoFor.provider-propagation -->
<!-- entities: Video -->
<!-- depends_on: Video generation executes via gateway with 15-minute timeout -->
<!-- enforced: generateVideoFor() -->
<!-- test: generateVideoFor.test.ts → "propagates errors from experimental_generateVideo (not swallowed)" -->

Errors from the Vercel AI SDK `experimental_generateVideo()` call (provider auth, rate limit, model not found, timeout) MUST be propagated to the caller — they are not swallowed like telemetry errors.

#### Scenario: Provider timeout error surfaces
- **WHEN** `experimental_generateVideo()` times out after 15 minutes
- **THEN** an AbortError is propagated to the caller

---

### Requirement: Model selection routes through Vercel AI Gateway

<!-- id: selectModel -->
<!-- entities: TextModel, OxagenTier -->
<!-- enforced: selectModel() -->
<!-- test: models.test.ts → "routes through the gateway at the balanced tier by default" -->

When a caller invokes `selectModel()` with an optional model id or tier, the function SHALL resolve the model id to a concrete Vercel AI Gateway model string and construct a `LanguageModel` via `gateway.languageModel(modelId)`. The gateway client reads `AI_GATEWAY_API_KEY` from the environment at call time.

#### Scenario: Default tier selection
<!-- test: models.test.ts → "routes through the gateway at the balanced tier by default" -->
- **WHEN** `selectModel()` is called with no arguments
- **THEN** the balanced tier env var (OXAGEN_LLM_BALANCED) is resolved to a gateway model id and passed to `gateway.languageModel()`

#### Scenario: Explicit tier selection
<!-- test: models.test.ts → "resolves the fast tier to its OXAGEN_LLM_FAST gateway id" -->
- **WHEN** `selectModel({ tier: "fast" })` is called
- **THEN** OXAGEN_LLM_FAST env var is resolved and passed to the gateway

#### Scenario: Explicit model id wins over tier
<!-- test: models.test.ts → "an explicit gateway model id wins over a tier" -->
- **WHEN** `selectModel({ model: "openai/gpt-5.2", tier: "fast" })` is called
- **THEN** the explicit model id "openai/gpt-5.2" is passed to the gateway; the tier is ignored

#### Scenario: Devtools middleware wrapping in development
- **WHEN** `process.env.NODE_ENV === "development"` and `@ai-sdk/devtools` is available
- **THEN** the returned `LanguageModel` is wrapped with devtools middleware for inspector visibility at localhost:4983

---

### Requirement: Image model selection routes through gateway with default

<!-- id: selectImageModel -->
<!-- entities: ImageModel -->
<!-- enforced: selectImageModel() -->
<!-- test: models.test.ts → "defaults to the gateway gpt-image-1 model" -->

When a caller invokes `selectImageModel()` with an optional model id, the function SHALL construct an `ImageModel` via `gateway.imageModel(modelId)` where modelId is the explicit argument or the default "openai/gpt-image-1".

#### Scenario: Default image model
<!-- test: models.test.ts → "defaults to the gateway gpt-image-1 model" -->
- **WHEN** `selectImageModel()` is called with no arguments
- **THEN** "openai/gpt-image-1" is passed to `gateway.imageModel()`

#### Scenario: Explicit image model
<!-- test: models.test.ts → "passes an explicit gateway image model id through" -->
- **WHEN** `selectImageModel({ model: "bfl/flux-2-max" })` is called
- **THEN** "bfl/flux-2-max" is passed to `gateway.imageModel()`

---

### Requirement: Video model selection routes through gateway with tier-based defaults

<!-- id: selectVideoModel -->
<!-- entities: VideoModel, MediaTier -->
<!-- enforced: selectVideoModel() -->
<!-- test: models.test.ts → "resolves video tiers from OXAGEN_LLM_VIDEO_* env" -->

When a caller invokes `selectVideoModel()` with an optional model id or media tier, the function SHALL construct an `Experimental_VideoModelV3` via `gateway.video(modelId)` where modelId is the explicit argument, the env-resolved tier, or the hardcoded tier default.

#### Scenario: Default video tier selection
- **WHEN** `selectVideoModel()` is called with no arguments
- **THEN** tier defaults to "basic"; OXAGEN_LLM_VIDEO_BASIC is resolved and passed to `gateway.video()`

#### Scenario: Advanced video tier
- **WHEN** `selectVideoModel({ tier: "advanced" })` is called
- **THEN** OXAGEN_LLM_VIDEO_ADVANCED env var is resolved and passed to `gateway.video()`

#### Scenario: Explicit video model wins over tier
- **WHEN** `selectVideoModel({ model: "google/veo-3.0-generate-001", tier: "basic" })` is called
- **THEN** the explicit model id is passed to `gateway.video()`; the tier is ignored

---

### Requirement: Tier env vars resolve to concrete gateway model ids

<!-- id: tierModelId -->
<!-- entities: OxagenTier, TextModel -->
<!-- enforced: tierModelId() -->
<!-- test: models.test.ts → "resolves the fast tier to its OXAGEN_LLM_FAST gateway id" -->

When a caller invokes `tierModelId(tier)`, the function SHALL read the corresponding `OXAGEN_LLM_FAST` / `OXAGEN_LLM_BALANCED` / `OXAGEN_LLM_PRECISE` env var and return its value (or fall back to a hardcoded default if the env var is missing).

#### Scenario: Read env for tier
- **WHEN** `tierModelId("precise")` is called
- **THEN** OXAGEN_LLM_PRECISE env var is read and returned

---

### Requirement: Media tier env vars resolve to concrete gateway model ids

<!-- id: imageTierModelId -->
<!-- entities: MediaTier, ImageModel -->
<!-- enforced: imageTierModelId() -->
<!-- test: models.test.ts → "resolves image tiers from OXAGEN_LLM_IMAGE_* env" -->

When a caller invokes `imageTierModelId(tier)`, the function SHALL read the corresponding `OXAGEN_LLM_IMAGE_BASIC` or `OXAGEN_LLM_IMAGE_ADVANCED` env var and return its value (or fall back to a hardcoded default if missing).

#### Scenario: Image basic tier
- **WHEN** `imageTierModelId("basic")` is called
- **THEN** OXAGEN_LLM_IMAGE_BASIC env var is read and returned

#### Scenario: Image advanced tier
- **WHEN** `imageTierModelId("advanced")` is called
- **THEN** OXAGEN_LLM_IMAGE_ADVANCED env var is read and returned

---

### Requirement: Video tier env vars resolve to concrete gateway model ids

<!-- id: videoTierModelId -->
<!-- entities: MediaTier, VideoModel -->
<!-- enforced: videoTierModelId() -->
<!-- test: models.test.ts → "resolves video tiers from OXAGEN_LLM_VIDEO_* env" -->

When a caller invokes `videoTierModelId(tier)`, the function SHALL read the corresponding `OXAGEN_LLM_VIDEO_BASIC` or `OXAGEN_LLM_VIDEO_ADVANCED` env var and return its value (or fall back to a hardcoded default if missing).

#### Scenario: Video basic tier
- **WHEN** `videoTierModelId("basic")` is called
- **THEN** OXAGEN_LLM_VIDEO_BASIC env var is read and returned

---

### Requirement: Resolved tier catalog joins all tiers to gateway models

<!-- id: resolvedTierCatalog -->
<!-- entities: TextModel, ImageModel, VideoModel -->
<!-- enforced: resolvedTierCatalog() -->
<!-- test: models.test.ts → "joins every tier to its concrete gateway model id" -->

When a caller invokes `resolvedTierCatalog()`, the function SHALL read all text and media tier env vars and return a single `ResolvedTierCatalog` object mapping every tier to its concrete gateway model id for client-side consumption.

#### Scenario: Complete tier catalog
<!-- test: models.test.ts → "joins every tier to its concrete gateway model id" -->
- **WHEN** `resolvedTierCatalog()` is called with all env vars set
- **THEN** result is `{ text: { fast, balanced, precise }, image: { basic, advanced }, video: { basic, advanced } }` with each field mapping to its gateway model id

---

### Requirement: Model id is extracted defensively from model objects

<!-- id: modelIdOf -->
<!-- entities: LanguageModel -->
<!-- enforced: modelIdOf() -->

When a caller invokes `modelIdOf(model)` with a `LanguageModel` (which is `string | LanguageModelV3`), the function SHALL return the model id string. If the input is already a string, it is returned as-is. If it is an object, the `modelId` property is read from the spec.

#### Scenario: String model input
- **WHEN** `modelIdOf("anthropic/claude-opus-4.8")` is called
- **THEN** "anthropic/claude-opus-4.8" is returned

#### Scenario: Model object input
- **WHEN** `modelIdOf({ modelId: "anthropic/claude-opus-4.8", ... })` is called
- **THEN** "anthropic/claude-opus-4.8" is read from the object and returned

---

### Requirement: Gateway model catalog is indexed by id and queryable by capability

<!-- id: getModel -->
<!-- entities: GatewayModel -->
<!-- enforced: getModel() -->
<!-- test: catalog.test.ts → "indexes every model by its gateway id" -->

The `gatewayModels` array is indexed into a `Map` keyed by `model.id`. When a caller invokes `getModel(id)`, the function SHALL return the `GatewayModel` object or `undefined` if not found.

#### Scenario: Model lookup by id
<!-- test: catalog.test.ts → "indexes every model by its gateway id" -->
- **WHEN** `getModel("anthropic/claude-opus-4.8")` is called
- **THEN** the `GatewayModel` object for Opus is returned

#### Scenario: Unknown model id
- **WHEN** `getModel("does/not-exist")` is called
- **THEN** `undefined` is returned

---

### Requirement: Reasoning capability is detected from catalog

<!-- id: supportsReasoning -->
<!-- entities: GatewayModel -->
<!-- enforced: supportsReasoning() -->
<!-- test: catalog.test.ts → "reports reasoning support from the capability array" -->

When a caller invokes `supportsReasoning(model)` with a model id string or object, the function SHALL resolve the model via `getModel()` and return `true` if the `capabilities` array includes "reasoning", else `false`. Unknown model ids return `false`.

#### Scenario: Reasoning-capable model
<!-- test: catalog.test.ts → "reports reasoning support from the capability array" -->
- **WHEN** `supportsReasoning("anthropic/claude-opus-4.8")` is called
- **THEN** `true` is returned (Opus has "reasoning" capability)

#### Scenario: Non-reasoning model
- **WHEN** `supportsReasoning("anthropic/claude-haiku-4.5")` is called
- **THEN** `false` is returned (Haiku lacks "reasoning" capability)

#### Scenario: Unknown model
- **WHEN** `supportsReasoning("unknown/model")` is called
- **THEN** `false` is returned conservatively

---

### Requirement: Image capability is detected from catalog

<!-- id: supportsImage -->
<!-- entities: GatewayModel -->
<!-- enforced: supportsImage() -->
<!-- test: catalog.test.ts → "classifies image vs video vs text capability" -->

When a caller invokes `supportsImage(model)`, the function SHALL return `true` if the model's `capabilities` array includes "image", else `false`.

#### Scenario: Image generation model
<!-- test: catalog.test.ts → "classifies image vs video vs text capability" -->
- **WHEN** `supportsImage("openai/gpt-image-1")` is called
- **THEN** `true` is returned

#### Scenario: Text-only model
- **WHEN** `supportsImage("anthropic/claude-opus-4.8")` is called
- **THEN** `false` is returned

---

### Requirement: Video capability is detected from catalog

<!-- id: supportsVideo -->
<!-- entities: GatewayModel -->
<!-- enforced: supportsVideo() -->
<!-- test: catalog.test.ts → "classifies image vs video vs text capability" -->

When a caller invokes `supportsVideo(model)`, the function SHALL return `true` if the model's `capabilities` array includes "video", else `false`.

#### Scenario: Video generation model
<!-- test: catalog.test.ts → "classifies image vs video vs text capability" -->
- **WHEN** `supportsVideo("google/veo-3.0-generate-001")` is called
- **THEN** `true` is returned

---

### Requirement: Text capability is detected by non-media capability presence

<!-- id: supportsText -->
<!-- entities: GatewayModel -->
<!-- enforced: supportsText() -->
<!-- test: catalog.test.ts → "classifies image vs video vs text capability" -->

When a caller invokes `supportsText(model)`, the function SHALL return `true` if the model's `capabilities` array contains at least one capability other than "image" or "video" (i.e., at least one of "reasoning", "vision", "tools", "audio"), else `false`. Pure media models are not text-capable.

#### Scenario: Chat model supports text
<!-- test: catalog.test.ts → "classifies image vs video vs text capability" -->
- **WHEN** `supportsText("anthropic/claude-opus-4.8")` is called
- **THEN** `true` is returned (has "reasoning", "vision", "tools")

#### Scenario: Pure image model does not support text
- **WHEN** `supportsText("openai/gpt-image-1")` is called
- **THEN** `false` is returned (capabilities = ["image"] only)

---

### Requirement: Media support is queried by kind

<!-- id: supportsMedia -->
<!-- entities: GatewayModel -->
<!-- enforced: supportsMedia() -->
<!-- test: catalog.test.ts → "supportsMedia dispatches on kind" -->

When a caller invokes `supportsMedia(model, kind)` with `kind = "image" | "video"`, the function SHALL dispatch to `supportsImage()` or `supportsVideo()` respectively.

#### Scenario: Image kind dispatch
<!-- test: catalog.test.ts → "supportsMedia dispatches on kind" -->
- **WHEN** `supportsMedia("openai/gpt-image-1", "image")` is called
- **THEN** `true` is returned

#### Scenario: Video kind dispatch
- **WHEN** `supportsMedia("google/veo-3.0-generate-001", "video")` is called
- **THEN** `true` is returned

---

### Requirement: Model defaults are resolved from user and workspace preferences with precedence

<!-- id: resolveModelDefaults -->
<!-- entities: User, Workspace, ModelDefaults -->
<!-- enforced: resolveModelDefaults() -->
<!-- test: resolve-model-defaults.test.ts → "returns all null and false override flags when both user and workspace are null" -->

When a caller invokes `resolveModelDefaults(input)` with user and workspace preference objects, the function SHALL apply cascade precedence: workspace value wins over user value, explicit model wins over tier, null is preserved. For each dimension (text, image, video), the function returns the resolved value and an `overriddenByWorkspace` flag indicating whether the workspace set that dimension.

#### Scenario: All-null defaults
<!-- test: resolve-model-defaults.test.ts → "returns all null and false override flags when both user and workspace are null" -->
- **WHEN** `resolveModelDefaults({ user: null, workspace: null })` is called
- **THEN** all text/image/video fields are null and all override flags are false

#### Scenario: User preferences only
<!-- test: resolve-model-defaults.test.ts → "uses user prefs when workspace is null (no override)" -->
- **WHEN** `resolveModelDefaults({ user: { defaultTextTier: "precise", ... }, workspace: null })`
- **THEN** user values are returned and all override flags are false

#### Scenario: Workspace preferences override user preferences
<!-- test: resolve-model-defaults.test.ts → "workspace values win over user values, all override flags are true" -->
- **WHEN** user has `defaultTextTier = "precise"` and workspace has `defaultTextTier = "fast"`
- **THEN** result returns workspace value "fast" and `overriddenByWorkspace.text = true`

#### Scenario: Explicit text model wins over text tier
<!-- test: resolve-model-defaults.test.ts → "text model beats tier at the user level when both are set" -->
- **WHEN** user has both `defaultTextTier = "fast"` and `defaultTextModel = "anthropic/claude-opus-4.8"`
- **THEN** both are returned in the result; caller prefers model over tier when model is non-null

#### Scenario: Workspace tier overrides user model
<!-- test: resolve-model-defaults.test.ts → "workspace tier overrides user model when workspace has no explicit model" -->
- **WHEN** user has `defaultTextModel = "anthropic/claude-opus-4.8"` and workspace has `defaultTextTier = "balanced"` (no model)
- **THEN** result returns workspace tier "balanced" and user model "anthropic/claude-opus-4.8"; override flag is true

#### Scenario: Partial workspace override
<!-- test: resolve-model-defaults.test.ts → "partial workspace override: only image overridden, text+video from user" -->
- **WHEN** workspace sets `defaultImageModel` only (text and video are null)
- **THEN** image is overridden (flag = true), text and video are not (flags = false)

---

### Requirement: Model defaults are loaded from database and resolved

<!-- id: loadEffectiveModelDefaults -->
<!-- entities: User, Workspace, ModelDefaults, Database -->
<!-- enforced: loadEffectiveModelDefaults() -->
<!-- test: load-effective-model-defaults.test.ts → "returns all-null defaults when user has no preferences and no workspace" -->

When a caller invokes `loadEffectiveModelDefaults({ userId, workspaceId })`, the function SHALL query the user's `auth.user_preferences` row and (if workspaceId is provided) the workspace's settings row, extract the model default columns, and delegate to `resolveModelDefaults()` for precedence logic.

#### Scenario: No user preferences, no workspace
<!-- test: load-effective-model-defaults.test.ts → "returns all-null defaults when user has no preferences and no workspace" -->
- **WHEN** `loadEffectiveModelDefaults({ userId: "user-1", workspaceId: null })` and user has no preferences row
- **THEN** all defaults are null and override flags are false

#### Scenario: User preferences only
<!-- test: load-effective-model-defaults.test.ts → "resolves user preferences when workspace is null" -->
- **WHEN** user has a preferences row with `defaultTextTier = "fast"` and `workspaceId = null`
- **THEN** the user's values are returned; override flags are false

#### Scenario: Workspace preferences override
<!-- test: load-effective-model-defaults.test.ts → "workspace preferences override user preferences" -->
- **WHEN** both user and workspace have preferences rows set
- **THEN** workspace values win; all override flags are true

#### Scenario: Workspace query is skipped when no workspace context
<!-- test: load-effective-model-defaults.test.ts → "does not query workspaces when workspaceId is null" -->
- **WHEN** `loadEffectiveModelDefaults({ userId: "user-2", workspaceId: null })` is called
- **THEN** the workspace query is never executed; only user preferences are queried

---

### Invariant: Model id extraction preserves string or object input

<!-- id: modelIdOf.invariant -->
<!-- entities: LanguageModel -->
<!-- enforced: modelIdOf() -->

The `modelIdOf()` function SHALL always return a non-empty string representing the model id, even if the input is an unusual union shape. If the input is a string, it is returned as-is. If it is an object without a `modelId` property, "unknown" is returned rather than undefined.

---

### Invariant: Image and video cost is priced from rate cards via provider and duration

<!-- id: generateImageFor.cost-invariant -->
<!-- entities: Image, Billing -->
<!-- enforced: generateImageFor() -->

Image generation cost (in `cost_usd_micros`) is determined by calling `imageProviderCostUsdMicros(modelId, imageCount, size)`, which reads the real per-image price from the image provider's rate card. Image models bill per asset, not per token.

---

### Invariant: Video cost is duration-based and read from rate card

<!-- id: generateVideoFor.cost-invariant -->
<!-- entities: Video, Billing -->
<!-- enforced: generateVideoFor() -->

Video generation cost (in `cost_usd_micros`) is determined by calling `videoProviderCostUsdMicros(modelId, durationSeconds)`, which reads the provider's per-second rate from the video rate card. Cost is `(durationSeconds * provider_rate)`.

---

### Invariant: All model selection routes through Vercel AI Gateway

<!-- id: gateway-invariant -->
<!-- entities: TextModel, ImageModel, VideoModel -->
<!-- enforced: selectModel(), selectImageModel(), selectVideoModel() -->

Every language, image, and video model must be constructed via `@ai-sdk/gateway` — there is no direct-provider fallback path. The gateway is the single authentication boundary and enables vendor-agnostic model selection via `creator/model` id strings.

---

### Invariant: Model tier defaults are fallback-safe

<!-- id: tier-default-invariant -->
<!-- entities: OxagenTier, MediaTier -->
<!-- enforced: tierModelId(), imageTierModelId(), videoTierModelId() -->

When env var reading returns undefined (e.g., in test environments where mocking omits the var), tier resolution functions coalesce to a hardcoded default rather than failing, so the selection functions remain callable.

---

### Invariant: Catalog models cover all capabilities

<!-- id: catalog-completeness-invariant -->
<!-- entities: GatewayModel -->
<!-- enforced: gatewayModels, getModel() -->

The `gatewayModels` array is the single source of truth for which Vercel AI Gateway models are surfaced in the Oxagen UI and which capabilities each supports. The array is immutable at runtime and covers text (reasoning, vision, tools) and media (image, video) models from all supported vendors.

---

### Invariant: Media tier env defaults point to media-capable models

<!-- id: media-tier-catalog-invariant -->
<!-- entities: ImageModel, VideoModel, GatewayModel -->
<!-- enforced: imageTierModelId(), videoTierModelId() -->
<!-- verified_by: catalog.test.ts → "every media env default resolves to a media-capable catalog entry" -->

The hardcoded defaults for `OXAGEN_LLM_IMAGE_*` and `OXAGEN_LLM_VIDEO_*` env vars (and the `IMAGE_DEFAULT_GATEWAY` / video tier defaults in code) MUST resolve to models in the `gatewayModels` catalog that have the corresponding "image" or "video" capability.

---

### Invariant: Workspace model defaults shadow user preferences

<!-- id: workspace-shadow-invariant -->
<!-- entities: User, Workspace, ModelDefaults -->
<!-- enforced: resolveModelDefaults() -->

When a workspace sets a model default for a dimension, that value MUST override the user's preference for the same dimension, even if the user's preference is non-null. The `overriddenByWorkspace` flags accurately track which dimensions are shadowed.

---

### Invariant: Explicit model always wins over tier

<!-- id: model-over-tier-invariant -->
<!-- entities: TextModel -->
<!-- enforced: selectModel(), resolveModelDefaults() -->

When both a model id and a tier are available (via env, selector arg, or database preference), the explicit model id takes precedence over the tier. Callers that receive both `text.model` and `text.tier` from the resolver MUST prefer model when model is non-null.

---

<!-- uncertainty: The exact format of imageProviderCostUsdMicros and videoProviderCostUsdMicros (which rate cards they read, how they price multi-image/multi-second scenarios) is in @oxagen/billing and not traced in source here; their behavior is inferred from call sites. -->

<!-- uncertainty: The VideoModel union shape and Experimental_VideoModelV3 type are not publicly exported from the AI SDK; the code declares a local type mirror. Future AI SDK changes to the video model shape could require updates. -->
